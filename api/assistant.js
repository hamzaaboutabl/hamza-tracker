import { GoogleGenAI } from '@google/genai';

const SUPABASE_URL = 'https://firnmcqtjprckgqdcplg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_oG0bcYmr6nijxKeY02U0YA_iHnp79gZ';
const MODEL = 'gemini-3.8-flash';
const PILLARS = ['College','Study','German','Training'];
const GERMAN_START = '2026-10-12';
const GERMAN_COURSE_WEEKLY_HOURS = 5;
const GERMAN_STUDY_WEEKLY_HOURS = 4;

const ATTENDANCE = {
  Saturday: [
    { id:'sat-computers-lecture', pillar:'College', label:'Introduction to Computers lecture' },
    { id:'sat-english-lecture', pillar:'College', label:'English Language lecture' }
  ],
  Monday: [
    { id:'mon-accounting-lecture', pillar:'College', label:'Principles of Accounting lecture' },
    { id:'mon-management-lecture', pillar:'College', label:'Principles of Management lecture' },
    { id:'mon-statistics-lecture', pillar:'College', label:'Introduction to Statistics lecture' },
    { id:'mon-german-course', pillar:'German', label:'German A1 course' }
  ],
  Thursday: [
    { id:'thu-computers-section', pillar:'College', label:'Introduction to Computers section' },
    { id:'thu-accounting-section', pillar:'College', label:'Principles of Accounting section' },
    { id:'thu-german-course', pillar:'German', label:'German A1 course' }
  ]
};

function isoDate(d = new Date()) {
  return d.toISOString().slice(0,10);
}
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}
function weekday(s) {
  return new Date(String(s) + 'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long',timeZone:'UTC'});
}
function uid(prefix='x') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clone(x) {
  return JSON.parse(JSON.stringify(x || {}));
}
function ensurePayload(p) {
  const out = p && typeof p === 'object' ? p : {};
  out.days = out.days && typeof out.days === 'object' ? out.days : {};
  out.sessions = out.sessions && typeof out.sessions === 'object' ? out.sessions : {};
  for (const p of PILLARS) out.sessions[p] = Array.isArray(out.sessions[p]) ? out.sessions[p] : [];
  out.attendance = out.attendance && typeof out.attendance === 'object' ? out.attendance : {};
  out.diary = Array.isArray(out.diary) ? out.diary : [];
  out.settings = out.settings && typeof out.settings === 'object' ? out.settings : {};
  return out;
}

async function request(path, token, options = {}) {
  const r = await fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      'Content-Type':'application/json',
      'apikey':SUPABASE_KEY,
      'Authorization':'Bearer ' + token,
      ...(options.headers || {})
    }
  });
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : (data?.message || data?.error || 'Supabase request failed');
    throw new Error(msg);
  }
  return data;
}
async function rpc(name, token, body={}) {
  return request('/rest/v1/rpc/' + name, token, {method:'POST',body:JSON.stringify(body)});
}
async function getUser(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer ' + token}
  });
  if (!r.ok) return null;
  const user = await r.json();
  return user?.id ? user : null;
}
async function getState(token, userId) {
  const rows = await request('/rest/v1/tracker_state?user_id=eq.' + encodeURIComponent(userId) + '&select=payload,updated_at', token, {method:'GET'});
  return ensurePayload(rows?.[0]?.payload || {});
}
async function saveState(token, userId, payload) {
  payload.settings = {...(payload.settings||{}), lastModified:new Date().toISOString()};
  await request('/rest/v1/tracker_state?on_conflict=user_id', token, {
    method:'POST',
    headers:{'Prefer':'resolution=merge-duplicates,return=minimal'},
    body:JSON.stringify({user_id:userId,payload,updated_at:new Date().toISOString()})
  });
}

function recentContext(payload, selectedDate) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate()-45);
  const cutoffDate = cutoff.toISOString().slice(0,10);
  const sessions = {};
  for (const p of ['Study','German','Training']) {
    sessions[p] = (payload.sessions?.[p] || [])
      .filter(x => validDate(x?.date) && x.date >= cutoffDate && (p !== 'German' || String(x?.type || '').toLowerCase() !== 'course'))
      .map(x => ({id:x.id,date:x.date,type:x.type,hours:Number(x.hours)||0}));
  }
  const attendance = {};
  for (const [date,map] of Object.entries(payload.attendance || {})) {
    if (date >= cutoffDate) attendance[date] = map;
  }
  const days = {};
  for (const [date,day] of Object.entries(payload.days || {})) {
    if (date >= cutoffDate) days[date] = {confirmed:!!day?.confirmed,exceptions:day?.exceptions||{}};
  }
  return {
    today:isoDate(),
    selectedDate:validDate(selectedDate)?selectedDate:null,
    attendanceSchedule:ATTENDANCE,
    recentSessions:sessions,
    recentAttendance:attendance,
    recentDays:days,
    rules:{
      college:'attendance-based',
      germanCourse:'attendance-based, starts 2026-10-12, 5 hours/week total across Monday and Thursday',
      germanStudy:'hour-based, starts 2026-10-12; about 4 hours/week, but not used as a performance target',
      studyAndTraining:'hour-based with no fixed daily or weekly target',
      performance:'consistency, growth and progress compare the user with their own history rather than a reference schedule',
      missing:'unlogged is missing, not zero'
    }
  };
}

const editTrackerTool = {
  type:'function',
  name:'edit_tracker',
  description:'Apply one or more edits to the signed-in user\'s Hamza Tracker data. Use this only when the user clearly asks you to log, correct, mark, confirm, add, update, remove, or save tracker data. You may combine many edits in one call.',
  parameters:{
    type:'object',
    properties:{
      operations:{
        type:'array',
        items:{
          type:'object',
          properties:{
            action:{
              type:'string',
              enum:['set_attendance','set_external_exception','add_session','update_session','delete_session','confirm_day','add_entry']
            },
            date:{type:'string',description:'YYYY-MM-DD'},
            pillar:{type:'string',enum:['College','Study','German','Training']},
            item_id:{type:'string',description:'Scheduled attendance item id from context.'},
            status:{type:'string',enum:['present','absent','cancelled','unlogged']},
            active:{type:'boolean',description:'For set_external_exception: true to excuse the commitment, false to clear it.'},
            reason:{type:'string',description:'Optional short reason, e.g. coach cancelled or institution closed.'},
            session_id:{type:'string'},
            activity_type:{type:'string'},
            hours:{type:'number'},
            confirmed:{type:'boolean'},
            text:{type:'string'}
          },
          required:['action']
        }
      }
    },
    required:['operations']
  }
};

function executeOperation(payload, op, userMessage) {
  const action = op?.action;
  const date = op?.date;
  const explicitDelete = /\b(delete|remove|erase)\b/i.test(userMessage);

  if (action === 'set_attendance') {
    if (!validDate(date)) return {ok:false,error:'Invalid attendance date.'};
    const scheduled = ATTENDANCE[weekday(date)] || [];
    const item = scheduled.find(x => x.id === op.item_id);
    if (!item) return {ok:false,error:'That attendance item is not scheduled on that date.'};
    if (item.pillar === 'German' && date < GERMAN_START) return {ok:false,error:'German course tracking starts on 2026-10-12.'};
    if (!['present','absent','cancelled','unlogged'].includes(op.status)) return {ok:false,error:'Invalid attendance status.'};
    payload.attendance[date] = payload.attendance[date] || {};
    if (op.status === 'unlogged') delete payload.attendance[date][item.id];
    else payload.attendance[date][item.id] = op.status;
    if (!Object.keys(payload.attendance[date]).length) delete payload.attendance[date];
    return {ok:true,summary:`${item.label}: ${op.status} on ${date}`};
  }

  if (action === 'set_external_exception') {
    if (!validDate(date)) return {ok:false,error:'Invalid exception date.'};
    if (!['College','German','Training'].includes(op.pillar)) return {ok:false,error:'External exceptions apply to College, German course, or Training.'};
    if (op.pillar === 'German' && date < GERMAN_START) return {ok:false,error:'German course tracking starts on 2026-10-12, so no exception is needed before then.'};
    payload.days[date] = payload.days[date] || {};
    payload.days[date].exceptions = payload.days[date].exceptions || {};
    if (op.active === false) {
      delete payload.days[date].exceptions[op.pillar];
      if (!Object.keys(payload.days[date].exceptions).length) delete payload.days[date].exceptions;
      return {ok:true,summary:`Cleared external cancellation for ${op.pillar} on ${date}`};
    }
    payload.days[date].exceptions[op.pillar] = {
      type:'external_cancelled',
      reason:String(op.reason || 'Externally cancelled').slice(0,120),
      updatedAt:new Date().toISOString()
    };
    return {ok:true,summary:`Marked ${op.pillar} externally cancelled on ${date}`};
  }

  if (action === 'add_session') {
    if (!validDate(date)) return {ok:false,error:'Invalid session date.'};
    if (!['Study','German','Training'].includes(op.pillar)) return {ok:false,error:'Only Study, German self-study, and Training are hour-based sessions.'};
    if (op.pillar === 'German' && date < GERMAN_START) return {ok:false,error:'German study tracking starts on 2026-10-12.'};
    const h = num(op.hours);
    if (h === null || h <= 0 || h > 24) return {ok:false,error:'Hours must be between 0 and 24.'};
    const defaultType = op.pillar === 'Study' ? 'Custom' : op.pillar === 'German' ? 'Self-study' : 'Other';
    let type = String(op.activity_type || defaultType).slice(0,80);
    if (op.pillar === 'German' && type.toLowerCase() === 'course') type = 'Self-study';
    const prefix = op.pillar === 'Study' ? 's' : op.pillar === 'German' ? 'g' : 't';
    const row = {id:uid(prefix),date,type,hours:h,note:'',createdAt:new Date().toISOString()};
    payload.sessions[op.pillar].push(row);
    return {ok:true,summary:`Added ${h}h ${op.pillar === 'German' ? 'German study' : op.pillar} (${type}) on ${date}`,session_id:row.id};
  }

  if (action === 'update_session') {
    if (!['Study','German','Training'].includes(op.pillar)) return {ok:false,error:'Invalid session pillar.'};
    const row = payload.sessions[op.pillar].find(x => x.id === op.session_id);
    if (!row) return {ok:false,error:'Session not found.'};
    if (op.pillar === 'German' && String(row.type || '').toLowerCase() === 'course') return {ok:false,error:'German course is tracked by attendance, not an hourly session.'};
    if (op.date !== undefined) {
      if (!validDate(op.date)) return {ok:false,error:'Invalid new date.'};
      if (op.pillar === 'German' && op.date < GERMAN_START) return {ok:false,error:'German study tracking starts on 2026-10-12.'};
      row.date = op.date;
    }
    if (op.hours !== undefined) {
      const h = num(op.hours);
      if (h === null || h <= 0 || h > 24) return {ok:false,error:'Hours must be between 0 and 24.'};
      row.hours = h;
    }
    if (op.activity_type !== undefined) {
      let type = String(op.activity_type).slice(0,80);
      if (op.pillar === 'German' && type.toLowerCase() === 'course') type = 'Self-study';
      row.type = type;
    }
    return {ok:true,summary:`Updated ${op.pillar === 'German' ? 'German study' : op.pillar} session ${op.session_id}`};
  }

  if (action === 'delete_session') {
    if (!explicitDelete) return {ok:false,error:'Session deletion requires the user to explicitly say delete/remove.'};
    if (!['Study','German','Training'].includes(op.pillar)) return {ok:false,error:'Invalid session pillar.'};
    const row = payload.sessions[op.pillar].find(x => x.id === op.session_id);
    if (!row) return {ok:false,error:'Session not found.'};
    if (op.pillar === 'German' && String(row.type || '').toLowerCase() === 'course') return {ok:false,error:'German course is attendance-based and cannot be deleted as an hourly study session.'};
    payload.sessions[op.pillar] = payload.sessions[op.pillar].filter(x => x.id !== op.session_id);
    return {ok:true,summary:`Deleted ${op.pillar === 'German' ? 'German study' : op.pillar} session ${op.session_id}`};
  }

  if (action === 'confirm_day') {
    if (!validDate(date)) return {ok:false,error:'Invalid day date.'};
    payload.days[date] = payload.days[date] || {};
    payload.days[date].confirmed = op.confirmed !== false;
    if (payload.days[date].confirmed) payload.days[date].confirmedAt = new Date().toISOString();
    else delete payload.days[date].confirmedAt;
    return {ok:true,summary:`${payload.days[date].confirmed?'Confirmed':'Unconfirmed'} ${date}`};
  }

  if (action === 'add_entry') {
    if (!validDate(date)) return {ok:false,error:'Invalid entry date.'};
    const text = String(op.text || '').trim().slice(0,2000);
    if (!text) return {ok:false,error:'Entry text is empty.'};
    payload.diary.push({id:uid('d'),date,category:'Entry',text,createdAt:new Date().toISOString()});
    return {ok:true,summary:`Saved an Entry on ${date}`};
  }

  return {ok:false,error:'Unknown tracker action.'};
}

export default async function handler(req,res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});

  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i,'');
    if (!token) return res.status(401).json({error:'Sign in first.'});

    const user = await getUser(token);
    if (!user) return res.status(401).json({error:'Session expired. Sign in again.'});

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({
      error:'Gemini is ready in the site code, but GEMINI_API_KEY still needs to be added to the Vercel project.'
    });

    const message = String(req.body?.message || '').trim().slice(0,3000);
    if (!message) return res.status(400).json({error:'Write a message first.'});

    const isOwner = await rpc('is_site_owner',token,{});
    const allowed = await rpc('consume_ai_request',token,{p_limit:20});
    if (!allowed) return res.status(429).json({error:'Daily assistant limit reached.'});

    let payload = await getState(token,user.id);
    const context = recentContext(payload,req.body?.selectedDate);

    const history = Array.isArray(req.body?.history)
      ? req.body.history.slice(-8).map(m => ({
          role:m?.role === 'assistant' ? 'assistant' : 'user',
          content:String(m?.content || '').slice(0,1400)
        })).filter(m=>m.content)
      : [];

    const historyText = history.length
      ? '\nRecent conversation:\n' + history.map(m=>`${m.role}: ${m.content}`).join('\n')
      : '';

    const prompt = [
      'You are the embedded assistant inside Hamza Tracker.',
      'You can both answer questions and edit the signed-in user\'s tracker using the edit_tracker tool.',
      'College is attendance-based. German course attendance starts on 2026-10-12 and totals 5 hours/week across Monday and Thursday. German self-study also starts on 2026-10-12 and is hour-based; about 4 hours/week is expected, but it is not a performance reference target. BIS Study and Training are hour-based.',
      'There is no fixed reference schedule and no fixed BIS Study or Training hour target. Performance is judged from the user\'s own history: recent stability, recent change, long-term change, and data coverage.',
      'Never invent facts the user did not provide. If an edit needs an unknown hour count, subject, attendance result, or date, ask one concise clarification instead of guessing.',
      'If the user says they completed the whole scheduled day, you may mark only the actual scheduled College/German attendance as present. Never invent Study, German self-study, or Training hours.',
      'Only delete a session if the user explicitly asks to delete/remove it.',
      'Never create German attendance or German study records before 2026-10-12.',
      'Do not modify other users, site code, admin settings, authentication, or server configuration.',
      'Do not automatically read or expose diary text or session notes. You may add an Entry only if the user explicitly asks you to save something as an entry.',
      'Treat unlogged data as missing, not as zero. If an institution, teacher, coach, gym, or course provider cancels a commitment, treat it as externally cancelled/excused rather than a discipline failure. Use set_external_exception for a whole College day, German course, or Training session. Use set_attendance with status cancelled when only one specific College/German class is called off.',
      'Never mark an externally cancelled commitment as missed. External cancellations must not count against consistency, growth, or progress. After editing, briefly state exactly what changed.',
      'The user is a teenager; keep responses age-appropriate and safe.',
      isOwner === true ? 'This signed-in account is the site owner; app-level assistant requests are not rate-limited.' : '',
      'Tracker context JSON: ' + JSON.stringify(context),
      historyText,
      '\nCurrent user message: ' + message
    ].filter(Boolean).join('\n');

    const ai = new GoogleGenAI({apiKey});
    let interaction = await ai.interactions.create({
      model:MODEL,
      store:false,
      input:prompt,
      tools:[editTrackerTool]
    });

    const actionSummaries = [];
    let changed = false;

    for (let turn=0; turn<4; turn++) {
      const calls = (interaction.steps || []).filter(s => s.type === 'function_call');
      if (!calls.length) break;

      const results = [];
      for (const call of calls) {
        if (call.name !== 'edit_tracker') {
          results.push({
            type:'function_result',
            name:call.name,
            call_id:call.id,
            result:[{type:'text',text:JSON.stringify({ok:false,error:'Unknown tool.'})}]
          });
          continue;
        }

        const ops = Array.isArray(call.arguments?.operations) ? call.arguments.operations.slice(0,30) : [];
        const opResults = [];
        for (const op of ops) {
          const result = executeOperation(payload,op,message);
          opResults.push(result);
          if (result.ok) {
            changed = true;
            if (result.summary) actionSummaries.push(result.summary);
          }
        }

        if (changed) await saveState(token,user.id,payload);

        results.push({
          type:'function_result',
          name:call.name,
          call_id:call.id,
          result:[{type:'text',text:JSON.stringify({results:opResults})}]
        });
      }

      interaction = await ai.interactions.create({
        model:MODEL,
        store:false,
        previous_interaction_id:interaction.id,
        input:results,
        tools:[editTrackerTool]
      });
    }

    const reply = String(interaction.output_text || '').trim() ||
      (actionSummaries.length ? 'Done: ' + actionSummaries.join('; ') : 'Done.');

    if (changed) payload = await getState(token,user.id);

    return res.status(200).json({
      reply,
      model:MODEL,
      owner:isOwner === true,
      changed,
      actions:actionSummaries,
      payload:changed ? payload : undefined
    });
  } catch (e) {
    return res.status(500).json({error:e?.message || 'Assistant error'});
  }
}
