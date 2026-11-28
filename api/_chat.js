// POST /api/chat: one step of the Hourglass assistant.
// The browser runs the tool loop (its tools use the student's own Firestore data and Google sign-in),
// and this function only adds the secret API key, the fixed system prompt and the tool list.
import Anthropic from '@anthropic-ai/sdk';
import { admin, hasAdmin, requireUser, sendError, readJson } from './_lib.js';
import { geminiChat } from './_gemini.js';

export const config = { maxDuration: 60 };

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'medium';
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 200);
// Server-side refusal fallback only exists on these models.
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1'];

// Which AI service to use: Anthropic (paid) if ANTHROPIC_API_KEY is set, otherwise Google Gemini (free tier) if GEMINI_API_KEY is set.
const provider = () => process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.GEMINI_API_KEY ? 'gemini' : null);
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// Kept byte-for-byte the same on every request so the prompt cache and saved conversations stay valid.
// Anything that changes (today's date, the student's logs, saved notes) is sent as a
// system message inside the conversation instead.
const SYSTEM = `You are the assistant inside Hourglass, an app that helps teenagers handle stress and manage their time. Its slogan is "Make every hour count." Students log their sleep (with how sleepy they felt that morning, 1-10), study/work time (with how productive they felt, 1-10) and free time, and keep deadlines on a calendar.

How to talk
- Be a warm, smart, down-to-earth helper, like a good older friend or tutor. Talk in normal conversational sentences, not menus or lists of commands. Never list "what you can do" unless asked.
- If the student asks why, how, or what you mean, explain your reasoning clearly and honestly.
- Match their length: short questions get short answers. Use simple formatting (short paragraphs, a few bullets) only when it helps.
- You can help with anything a capable general assistant can: explaining homework concepts, study plans, writing help, planning a week, talking through stress, answering general questions. You are not limited to the app's features. Use web search when current or factual information would help.
- Encourage healthy habits (about 8-10 hours of sleep for teens, breaks, balance) without lecturing. Notice patterns in their data and point them out kindly when relevant.
- You are not a therapist or doctor. If a student mentions self-harm, suicide, abuse, or being in danger, respond with care, encourage them to talk to a trusted adult or school counselor, and share that in the US they can call or text 988 (Suicide & Crisis Lifeline) any time, or 911 in an emergency.
- Never help with anything harmful, sexual, or illegal, and never help a student deceive or bully someone.

Taking actions
- Use your tools whenever they help. Do the task instead of telling the student how to do it. You can chain several tools to finish a request.
- When a request is ambiguous in a way that matters (which file, which day, who to email), ask one short question. Otherwise make a sensible choice and say what you did.
- Dates: use the "Today" date in the latest context message. Resolve words like "tomorrow" or "Friday" from it, and use YYYY-MM-DD in tool calls.
- If a tool says a Google service is not linked, tell the student to link it in Settings, then continue with what you can do.
- Never invent the contents of files, emails or calendars: read them with tools first.

Email
- To send an email, call draft_email. The student sees the draft and presses Send themselves, so never claim an email was sent until a later message confirms it.
- Every email must be complete and polished: a clear specific subject, a greeting ("Dear Ms. Lee," or "Hi Sam," for a friend), a well-organized body with correct grammar and spelling, and a closing such as "Best regards," followed by the student's name on its own line. Match the tone to the recipient (formal for teachers, coaches and adults; casual for friends).
- Use the student's name from the context message. If it is unknown, ask for it once and save it with remember.
- When the student asks you to summarize emails, search and read them first, then give a short, organized summary.

Study materials from Google Drive
- drive_search finds any kind of file (Google Docs, Slides, Sheets, PDFs, Word files, text). Read the files with drive_read_file before writing anything about them.
- You can make summaries, study guides, flashcards, outlines and practice tests. For a practice quiz, call show_quiz so the student can take it inside the app (answers and explanations appear only after they submit). Use application-based questions, not just definitions. Every time they ask for another quiz on the same material, write completely new questions.
- If they want to keep the material, save it with drive_create_doc.

Deadlines and calendar
- add_deadline saves a deadline in Hourglass (and Google Calendar too when linked). When the student mentions an assignment, test or due date, offer to add it, or add it directly when they ask. Break big projects into smaller study deadlines when that helps.

Learning about the student
- The context message includes notes you saved earlier. Use them to personalize help (their name, classes, teachers' emails, goals, what stresses them, how they like to study, when they usually sleep).
- When you learn something lasting and useful about the student, or notice a pattern in their logs, save it with remember (one short fact per note). Don't save secrets, passwords, or sensitive personal details. Use forget when a note is wrong or outdated.`;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const date = d => str(d || 'Date as YYYY-MM-DD');
const TOOLS = [
  {
    name: 'log_time',
    description: 'Save how much time the student spent on sleep, study/work or free time on a day. Replaces any earlier entry for the same category and day.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['sleep', 'work', 'free'], description: 'sleep, work (study, homework or a job) or free (free time)' },
        date: date('Day the time belongs to (for sleep, the day they woke up), YYYY-MM-DD'),
        hours: { type: 'number', description: 'Hours, 0-24, decimals allowed (7.5 = 7h 30m)' },
        rating: { type: 'integer', description: 'Sleep: how sleepy they felt in the morning (1 wide awake, 10 very sleepy). Work: how productive they felt (1 not at all, 10 very). Omit for free time or if unknown.' }
      },
      required: ['category', 'date', 'hours']
    }
  },
  {
    name: 'delete_log',
    description: 'Delete the student\'s log for one category on one day.',
    input_schema: { type: 'object', properties: { category: { type: 'string', enum: ['sleep', 'work', 'free'] }, date: date() }, required: ['category', 'date'] }
  },
  {
    name: 'get_logs',
    description: 'Get the student\'s time logs between two dates (inclusive), with daily hours and ratings, to analyze trends.',
    input_schema: { type: 'object', properties: { start_date: date(), end_date: date(), category: { type: 'string', enum: ['sleep', 'work', 'free'], description: 'Optional filter' } }, required: ['start_date', 'end_date'] }
  },
  {
    name: 'add_deadline',
    description: 'Add a deadline to the student\'s Hourglass calendar. Also copies it to Google Calendar when that is linked.',
    input_schema: {
      type: 'object',
      properties: { title: str('What is due, e.g. "Bio test: Unit 4"'), date: date('Due date, YYYY-MM-DD'), time: str('Optional due time, 24-hour HH:MM') },
      required: ['title', 'date']
    }
  },
  {
    name: 'list_deadlines',
    description: 'List the student\'s Hourglass deadlines (each with its id), upcoming first.',
    input_schema: { type: 'object', properties: { include_past: { type: 'boolean' } } }
  },
  {
    name: 'delete_deadline',
    description: 'Delete an Hourglass deadline by its id (get ids from list_deadlines).',
    input_schema: { type: 'object', properties: { id: str('Deadline id') }, required: ['id'] }
  },
  {
    name: 'set_reminders',
    description: 'Replace the student\'s daily reminder alerts (push notifications). Pass the full list you want to keep.',
    input_schema: {
      type: 'object',
      properties: { alerts: { type: 'array', items: { type: 'object', properties: { time: str('24-hour HH:MM'), label: str('Message shown in the notification') }, required: ['time'] } } },
      required: ['alerts']
    }
  },
  {
    name: 'remember',
    description: 'Save one short, lasting fact about the student or a pattern you noticed, so you can personalize help in future chats.',
    input_schema: { type: 'object', properties: { note: str('One short fact, e.g. "Name: Priya Shah" or "Gets most homework done before 9pm"') }, required: ['note'] }
  },
  {
    name: 'forget',
    description: 'Delete a saved note that is wrong or outdated. Pass its exact text.',
    input_schema: { type: 'object', properties: { note: str('Exact text of the note to delete') }, required: ['note'] }
  },
  {
    name: 'gmail_search',
    description: 'Search the student\'s Gmail. Uses Gmail search syntax (from:, to:, subject:, newer_than:7d, is:unread, etc.). Returns id, from, subject, date and a snippet for each message.',
    input_schema: { type: 'object', properties: { query: str('Gmail search query'), max_results: { type: 'integer', description: '1-25, default 10' } }, required: ['query'] }
  },
  {
    name: 'gmail_read',
    description: 'Read the full text of one Gmail message by id.',
    input_schema: { type: 'object', properties: { message_id: str('Message id from gmail_search') }, required: ['message_id'] }
  },
  {
    name: 'draft_email',
    description: 'Show the student a finished email draft with a Send button. Nothing is sent until they press Send. Write the complete email: subject, greeting, body and closing with their name.',
    input_schema: {
      type: 'object',
      properties: {
        to: str('Recipient email address (comma-separated for several)'),
        cc: str('Optional CC addresses, comma-separated'),
        subject: str('Clear, specific subject line'),
        body: str('Full plain-text email, starting with the greeting and ending with the closing and name'),
        reply_to_message_id: str('Optional Gmail message id when this is a reply, so it stays in the same thread')
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'calendar_list_events',
    description: 'List events on the student\'s Google Calendar between two dates (inclusive).',
    input_schema: { type: 'object', properties: { start_date: date(), end_date: date() }, required: ['start_date', 'end_date'] }
  },
  {
    name: 'calendar_create_event',
    description: 'Create an event (not a deadline) on the student\'s Google Calendar, such as a study session.',
    input_schema: {
      type: 'object',
      properties: { title: str('Event title'), date: date(), start_time: str('Optional 24-hour HH:MM; omit for all-day'), end_time: str('Optional 24-hour HH:MM'), description: str('Optional details') },
      required: ['title', 'date']
    }
  },
  {
    name: 'drive_search',
    description: 'Search the student\'s Google Drive for files of any type (Google Docs, Slides, Sheets, PDFs, Word, PowerPoint, text, folders) by name or by words inside the file. Returns id, name, type, modified date and parent folder.',
    input_schema: {
      type: 'object',
      properties: {
        query: str('Words to look for in the file name or contents. Leave empty to list recent files.'),
        type: { type: 'string', enum: ['any', 'doc', 'slides', 'sheet', 'pdf', 'word', 'powerpoint', 'folder'], description: 'Optional file type filter' },
        in_folder_id: str('Optional: only files directly inside this folder id')
      }
    }
  },
  {
    name: 'drive_read_file',
    description: 'Read the text of a Google Drive file (Docs, Slides, Sheets, PDFs, Word, PowerPoint, text). For a folder id, returns the list of files in it.',
    input_schema: { type: 'object', properties: { file_id: str('File id from drive_search') }, required: ['file_id'] }
  },
  {
    name: 'drive_create_doc',
    description: 'Save study material (summary, study guide, flashcards, quiz) as a new Google Doc in the student\'s Drive. Returns a link.',
    input_schema: { type: 'object', properties: { title: str('Document title'), content: str('Plain text or simple Markdown content') }, required: ['title', 'content'] }
  },
  {
    name: 'show_quiz',
    description: 'Show an interactive practice quiz in the app. The student answers every question, then submits; only then do they see which answers were right and why.',
    input_schema: {
      type: 'object',
      properties: {
        title: str('Quiz title'),
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: str('Question text (prefer real-world scenarios that apply the idea)'),
              choices: { type: 'array', items: { type: 'string' }, description: 'Optional answer choices for multiple choice; omit for a typed answer' },
              answer: str('The correct answer (must match one choice exactly for multiple choice)'),
              explanation: str('Why that answer is right')
            },
            required: ['question', 'answer', 'explanation']
          }
        }
      },
      required: ['title', 'questions']
    }
  },
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
];

async function countUsage(uid) {
  if (!hasAdmin()) return true; // the daily limit needs the optional service account
  const { db } = await admin();
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.doc(`usage/${uid}`);
  return db.runTransaction(async t => {
    const snap = await t.get(ref);
    const d = snap.exists ? snap.data() : {};
    const count = d.day === day ? d.count || 0 : 0;
    if (count >= DAILY_LIMIT) return false;
    t.set(ref, { day, count: count + 1, updatedAt: new Date() });
    return true;
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const which = provider();
    if (!which) throw Object.assign(new Error('The AI is not set up yet: add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in Vercel (SETUP.md, step 3).'), { status: 503 });
    const user = await requireUser(req);
    const { messages } = await readJson(req);
    if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('No messages.'), { status: 400 });
    if (JSON.stringify(messages).length > 4_000_000) throw Object.assign(new Error('This chat is too long. Start a new chat.'), { status: 413 });
    if (messages.some(m => !['user', 'assistant', 'system'].includes(m?.role))) throw Object.assign(new Error('Bad message.'), { status: 400 });
    if (!(await countUsage(user.uid))) throw Object.assign(new Error(`You've reached today's limit of ${DAILY_LIMIT} AI steps. It resets tomorrow.`), { status: 429 });

    if (which === 'gemini') {
      const r = await geminiChat({
        system: SYSTEM.replace(' Use web search when current or factual information would help.', ''),
        tools: TOOLS, messages, apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
      });
      return res.status(200).json(r);
    }

    const betas = ['thinking-binding-controls-2026-08-01'];
    const extra = {};
    if (FALLBACK_MODELS.includes(MODEL)) { betas.push('server-side-fallback-2026-07-01'); extra.fallbacks = 'default'; }

    const r = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas,
      ...extra,
      // If an older saved turn ever changes, drop its hidden reasoning instead of failing the request.
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: EFFORT },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: TOOLS,
      messages
    });
    res.status(200).json({ content: r.content, stop_reason: r.stop_reason, stop_details: r.stop_details ?? null });
  } catch (err) {
    if (err.geminiStatus === 429) return sendError(res, Object.assign(new Error('The free AI is busy right now (free keys have a per-minute limit). Wait a minute and try again.'), { status: 429 }));
    if (err.geminiStatus) { console.error('gemini', err.geminiStatus, err.message); return sendError(res, Object.assign(new Error(`Google's AI said (${err.geminiStatus}): ${String(err.message).slice(0, 220)}`), { status: 502 })); }
    if (err instanceof Anthropic.RateLimitError) return sendError(res, Object.assign(new Error('The AI is busy right now. Try again in a minute.'), { status: 429 }));
    if (err instanceof Anthropic.AuthenticationError) return sendError(res, Object.assign(new Error('The AI key in Vercel is not valid.'), { status: 500 }));
    if (err instanceof Anthropic.BadRequestError) { console.error(err); return sendError(res, Object.assign(new Error('The AI could not read this chat. Start a new chat and try again.'), { status: 400 })); }
    if (err instanceof Anthropic.APIConnectionError) return sendError(res, Object.assign(new Error('Could not reach the AI. Try again.'), { status: 502 }));
    sendError(res, err);
  }
}
