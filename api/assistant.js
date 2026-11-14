import { GoogleGenAI } from '@google/genai';

const SUPABASE_URL = 'https://firnmcqtjprckgqdcplg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_oG0bcYmr6nijxKeY02U0YA_iHnp79gZ';
const MODEL = 'gemini-3.8-flash';
const PILLARS = ['College','Study','German','Training','Walking'];
const GERMAN_START = '2026-10-12';
const GERMAN_COURSE_WEEKLY_HOURS = 5;
const GERMAN_STUDY_WEEKLY_HOURS = 4;
const TRAINING_ATTENDANCE_ID = 'training-session';
const SUBJECT_COURSES = {
  accounting:'Principles of Accounting',
  management:'Principles of Management',
  statistics:'Introduction to Statistics'
};

const ATTENDANCE = {
  Saturday: [
    { id:'sat-computers-lecture', pillar:'College', label:'Introduction to Computers lecture' },
    { id:'sat-english-lecture', pillar:'College', label:'English Language lecture' }
  ],
  Monday: [
    { id:'mon-accounting-lecture', pillar:'College', label:'Principles of Accounting lecture', courseEligible:true },
    { id:'mon-management-lecture', pillar:'College', label:'Principles of Management lecture', courseEligible:true },
    { id:'mon-statistics-lecture', pillar:'College', label:'Introduction to Statistics lecture', courseEligible:true },
    { id:'mon-german-course', pillar:'German', label:'German A1 course' }
  ],
  Thursday: [
    { id:'thu-computers-section', pillar:'College', label:'Introduction to Computers section' },
    { id:'thu-accounting-section', pillar:'College', label:'Principles of Accounting section', courseEligible:true },
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
  out.courseLogs = out.courseLogs && typeof out.courseLogs === 'object' ? out.courseLogs : {};
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
  for (const p of ['Study','German','Training','Walking']) {
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
    if (date >= cutoffDate) days[date] = {exceptions:day?.exceptions||{}};
  }
  const courseLogs = {};
  for (const [date,map] of Object.entries(payload.courseLogs || {})) {
    if (date >= cutoffDate) courseLogs[date] = map;
  }
  return {
    today:isoDate(),
    selectedDate:validDate(selectedDate)?selectedDate:null,
    attendanceSchedule:ATTENDANCE,
    trainingAttendanceId:TRAINING_ATTENDANCE_ID,
    recentSessions:sessions,
    recentAttendance:attendance,
    recentSubjectCourseLogs:courseLogs,
    selectedDateSubjectCourses:validDate(selectedDate)?(payload.courseLogs?.[selectedDate]||{}):{},
    recentDays:days,
    rules:{
      scoring:'College attendance and German course attendance are attendance-based. Training contributes a composite of 50% attendance and 50% completed scheduled hours. These three categories are equally weighted when data exists.',
      college:'attendance-based from the real college schedule. Accounting, Management, and Statistics can be logged as subject courses on any day Saturday through Thursday; Friday course logging is unavailable. A course log replaces College attendance only when that same subject has a scheduled College session on that date. On other days it is recorded separately and does not change the College score. Computers and English have no course replacement.',
      germanCourse:'attendance-based, starts 2026-10-12',
      training:'50% attendance + 50% scheduled completed hours. Weekly scheduled target is 18 hours: Saturday 3h, Sunday 4h, Tuesday 4h, Wednesday 4h, Thursday 3h. Monday and Friday are optional extras and do not add to the scheduled-hours target. Called-off days are excluded.',
      study:'hours are logged for information only and never scored',
      germanStudy:'hours are logged for information only and never scored; starts 2026-10-12',
      trainingHours:'Training hours count toward the scheduled-hours half of the Training score; Study and German self-study hours remain informational only',
      calledOff:'cancelled-by-institution/teacher/coach items are excluded from scores',
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
              enum:['set_attendance','set_subject_course','set_external_exception','add_session','update_session','delete_session','add_entry']
            },
            date:{type:'string',description:'YYYY-MM-DD'},
            pillar:{type:'string',enum:['College','Study','German','Training','Walking']},
            item_id:{type:'string',description:'Attendance item id from context. Use training-session for Training.'},
            status:{type:'string',enum:['present','absent','cancelled','unlogged','course_in_person','course_online'],description:'For eligible scheduled College subjects, course_in_person or course_online replaces College attendance and counts as present.'},
            subject_id:{type:'string',enum:['accounting','management','statistics'],description:'Subject for set_subject_course.'},
            mode:{type:'string',enum:['in_person','online','clear'],description:'For set_subject_course: how the subject course was completed, or clear the log.'},
            active:{type:'boolean',description:'For set_external_exception: true to excuse the commitment, false to clear it.'},
            reason:{type:'string',description:'Optional short reason, e.g. coach cancelled or institution closed.'},
            session_id:{type:'string'},
            activity_type:{type:'string'},
            hours:{type:'number'},
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
    if (!['present','absent','cancelled','unlogged','course_in_person','course_online'].includes(op.status)) return {ok:false,error:'Invalid attendance status.'};

    if (op.item_id === TRAINING_ATTENDANCE_ID || op.pillar === 'Training') {
      if (op.status === 'course_in_person' || op.status === 'course_online') return {ok:false,error:'Training cannot use College subject-course attendance options.'};
      payload.days[date] = payload.days[date] || {};
      payload.days[date].exceptions = payload.days[date].exceptions || {};
      if (op.status === 'cancelled') {
        payload.days[date].exceptions.Training = {type:'external_cancelled',reason:'Training called off',updatedAt:new Date().toISOString()};
        payload.attendance[date] = payload.attendance[date] || {};
        delete payload.attendance[date][TRAINING_ATTENDANCE_ID];
      } else {
        delete payload.days[date].exceptions.Training;
        if (!Object.keys(payload.days[date].exceptions).length) delete payload.days[date].exceptions;
        payload.attendance[date] = payload.attendance[date] || {};
        if (op.status === 'unlogged') delete payload.attendance[date][TRAINING_ATTENDANCE_ID];
        else payload.attendance[date][TRAINING_ATTENDANCE_ID] = op.status;
      }
      if (payload.attendance[date] && !Object.keys(payload.attendance[date]).length) delete payload.attendance[date];
      return {ok:true,summary:`Training: ${op.status} on ${date}`};
    }

    const scheduled = ATTENDANCE[weekday(date)] || [];
    const item = scheduled.find(x => x.id === op.item_id);
    if (!item) return {ok:false,error:'That College/German attendance item is not scheduled on that date.'};
    if (item.pillar === 'German' && date < GERMAN_START) return {ok:false,error:'German course tracking starts on 2026-10-12.'};
    if ((op.status === 'course_in_person' || op.status === 'course_online') && !item.courseEligible) return {ok:false,error:'Only Accounting, Management, and Statistics can use a subject course instead of College attendance.'};
    if (item.courseEligible) {
      const subjectId = Object.entries(SUBJECT_COURSES).find(([,label]) => label === item.label)?.[0];
      if (subjectId) {
        payload.courseLogs = payload.courseLogs || {};
        payload.courseLogs[date] = payload.courseLogs[date] || {};
        if (op.status === 'course_in_person') payload.courseLogs[date][subjectId] = 'in_person';
        else if (op.status === 'course_online') payload.courseLogs[date][subjectId] = 'online';
        else delete payload.courseLogs[date][subjectId];
        if (!Object.keys(payload.courseLogs[date]).length) delete payload.courseLogs[date];
      }
    }
    payload.attendance[date] = payload.attendance[date] || {};
    if (op.status === 'unlogged') delete payload.attendance[date][item.id];
    else payload.attendance[date][item.id] = op.status;
    if (!Object.keys(payload.attendance[date]).length) delete payload.attendance[date];
    const label = op.status === 'course_in_person' ? 'subject course attended in person' : op.status === 'course_online' ? 'subject course watched online' : op.status;
    return {ok:true,summary:`${item.label}: ${label} on ${date}`};
  }

  if (action === 'set_subject_course') {
    if (!validDate(date)) return {ok:false,error:'Invalid subject-course date.'};
    const day = weekday(date);
    if (day === 'Friday') return {ok:false,error:'Subject courses can only be logged Saturday through Thursday.'};
    if (!Object.prototype.hasOwnProperty.call(SUBJECT_COURSES,op.subject_id)) return {ok:false,error:'Choose Accounting, Management, or Statistics.'};
    if (!['in_person','online','clear'].includes(op.mode)) return {ok:false,error:'Choose in_person, online, or clear.'};
    payload.courseLogs = payload.courseLogs || {};
    payload.courseLogs[date] = payload.courseLogs[date] || {};
    if (op.mode === 'clear') delete payload.courseLogs[date][op.subject_id];
    else payload.courseLogs[date][op.subject_id] = op.mode;
    if (!Object.keys(payload.courseLogs[date]).length) delete payload.courseLogs[date];
    const item = (ATTENDANCE[day] || []).find(x => x.pillar === 'College' && x.courseEligible && x.label === SUBJECT_COURSES[op.subject_id]);
    if (item) {
      payload.attendance[date] = payload.attendance[date] || {};
      const existing = payload.attendance[date][item.id];
      if (op.mode === 'in_person') payload.attendance[date][item.id] = 'course_in_person';
      else if (op.mode === 'online') payload.attendance[date][item.id] = 'course_online';
      else if (['course_in_person','course_online'].includes(existing)) delete payload.attendance[date][item.id];
      if (!Object.keys(payload.attendance[date]).length) delete payload.attendance[date];
    }
    const label = SUBJECT_COURSES[op.subject_id];
    const modeLabel = op.mode === 'in_person' ? 'attended in person' : op.mode === 'online' ? 'watched online' : 'log cleared';
    return {ok:true,summary:`${label}: ${modeLabel} on ${date}${item?' (also updated today\'s College attendance)':''}`};
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
    if (!['Study','German','Training','Walking'].includes(op.pillar)) return {ok:false,error:'Only Study, German self-study, Training, and Walking use hour sessions.'};
    if (op.pillar === 'German' && date < GERMAN_START) return {ok:false,error:'German study tracking starts on 2026-10-12.'};
    const h = num(op.hours);
    if (h === null || h <= 0 || h > 24) return {ok:false,error:'Hours must be between 0 and 24.'};
    const defaultType = op.pillar === 'Study' ? 'Custom' : op.pillar === 'German' ? 'Self-study' : op.pillar === 'Walking' ? 'Walking' : 'Other';
    let type = String(op.activity_type || defaultType).slice(0,80);
    if (op.pillar === 'German' && type.toLowerCase() === 'course') type = 'Self-study';
    const prefix = op.pillar === 'Study' ? 's' : op.pillar === 'German' ? 'g' : op.pillar === 'Walking' ? 'w' : 't';
    const row = {id:uid(prefix),date,type,hours:h,note:'',createdAt:new Date().toISOString()};
    payload.sessions[op.pillar].push(row);
    return {ok:true,summary:`Added ${h}h ${op.pillar === 'German' ? 'German study' : op.pillar} (${type}) on ${date}`,session_id:row.id};
  }

  if (action === 'update_session') {
    if (!['Study','German','Training','Walking'].includes(op.pillar)) return {ok:false,error:'Study, German self-study, Training, and Walking have hour sessions.'};
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
    if (!['Study','German','Training','Walking'].includes(op.pillar)) return {ok:false,error:'Study, German self-study, Training, and Walking have hour sessions.'};
    const row = payload.sessions[op.pillar].find(x => x.id === op.session_id);
    if (!row) return {ok:false,error:'Session not found.'};
    if (op.pillar === 'German' && String(row.type || '').toLowerCase() === 'course') return {ok:false,error:'German course is attendance-based and cannot be deleted as an hourly study session.'};
    payload.sessions[op.pillar] = payload.sessions[op.pillar].filter(x => x.id !== op.session_id);
    return {ok:true,summary:`Deleted ${op.pillar === 'German' ? 'German study' : op.pillar} session ${op.session_id}`};
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
      'You can answer questions and edit the signed-in user\'s tracker with the edit_tracker tool.',
      'Performance scoring uses College attendance, German course attendance, and Training. Training is 50% attendance and 50% completed scheduled hours. Study and German self-study hours are informational only.',
      'Training has an 18-hour weekly target: Saturday 3h, Sunday 4h, Tuesday 4h, Wednesday 4h, Thursday 3h. Monday and Friday are optional extras and do not increase the scheduled-hours score.',
      'College attendance comes from the actual College lecture/section schedule. For Accounting, Management, and Statistics, completing the subject course in person or watching it online can replace the corresponding College session and counts as present. Computers and English have no course replacement. German course attendance starts on 2026-10-12. Default Training days are Saturday, Sunday, Tuesday, Wednesday, and Thursday. There is no default Training on Monday or Friday. Use item_id training-session for Training attendance.',
      'If the user says they trained, mark Training present even on Monday or Friday; those days are optional extras rather than expected sessions. If they skipped a planned default Training day, mark it absent. If the coach/gym called off a default Training day, mark it cancelled/external and it must not hurt the score. Never mark Monday or Friday missed/cancelled merely because no Training happened there.',
      'Study and German self-study may be logged in hours for information only. Walking is a separate optional activity logged by duration in hours; it is informational only and never affects Training or performance scores. Training hours count toward the scheduled-hours half of the Training score. Never invent hours.',
      'Never invent attendance, dates, subjects, or hours. Ask one concise clarification when a needed fact is missing.',
      'Only delete a study session if the user explicitly asks to delete/remove it.',
      'Never create German course attendance or German self-study records before 2026-10-12.',
      'Do not modify other users, site code, admin settings, authentication, or server configuration.',
      'Do not automatically read or expose diary text or session notes. Add an Entry only if the user explicitly asks.',
      'Unlogged means missing, not zero. College/German classes or Training called off by the institution, teacher, or coach are excluded from scoring rather than counted as misses.',
      'After editing, briefly state exactly what changed.',
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
