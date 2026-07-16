import { allowMethods, chargeTokens, cleanText, db, errorDetails, getModel, getTrialModelId, handleError, requireUser } from './_lib.js';

function extractDownloadableFiles(text) {
  const files = [];
  const re = /```file-([^\n`]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(String(text || ''))) && files.length < 8) {
    files.push({ name: match[1].trim(), content: match[2].replace(/\n$/, '') });
  }
  return files;
}

function safeDownloadFilename(value) {
  return String(value || 'aiway-file.txt')
    .replace(/[\r\n\0]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .slice(0, 150) || 'aiway-file.txt';
}

function fileContentType(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const types = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
    xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml; charset=utf-8', py: 'text/x-python; charset=utf-8',
    java: 'text/x-java-source; charset=utf-8', c: 'text/x-c; charset=utf-8', cpp: 'text/x-c++; charset=utf-8',
    ts: 'text/typescript; charset=utf-8', tsx: 'text/typescript; charset=utf-8', jsx: 'text/javascript; charset=utf-8',
    sql: 'application/sql; charset=utf-8', yaml: 'application/yaml; charset=utf-8', yml: 'application/yaml; charset=utf-8'
  };
  return types[ext] || 'application/octet-stream';
}


function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeStoreZip(files) {
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(safeDownloadFilename(file.name), 'utf8');
    const data = Buffer.from(file.content, 'utf8'); const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50,0); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(0,8); header.writeUInt16LE(0,10); header.writeUInt16LE(0,12); header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26);
    local.push(header,name,data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6); ch.writeUInt16LE(0x800,8); ch.writeUInt16LE(0,10); ch.writeUInt16LE(0,12); ch.writeUInt16LE(0,14); ch.writeUInt32LE(crc,16); ch.writeUInt32LE(data.length,20); ch.writeUInt32LE(data.length,24); ch.writeUInt16LE(name.length,28); ch.writeUInt32LE(offset,42); central.push(ch,name); offset += header.length + name.length + data.length;
  }
  const centralSize = central.reduce((n,b)=>n+b.length,0); const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(centralSize,12); end.writeUInt32LE(offset,16); return Buffer.concat([...local,...central,end]);
}
async function downloadGeneratedProject(req,res) {
  const token=String(req.query?.token||''),messageId=String(req.query?.messageId||''); if(!messageId) throw new Error('UNAUTHORIZED');
  const original=req.headers.authorization; if(token) req.headers.authorization=`Bearer ${token}`; const user=await requireUser(req); req.headers.authorization=original;
  const {data:message,error}=await db().from('messages').select('id,content,role').eq('id',messageId).eq('user_id',user.id).eq('role','assistant').single(); if(error||!message) throw new Error('FILE_NOT_FOUND');
  const files=extractDownloadableFiles(message.content); if(!files.length) throw new Error('FILE_NOT_FOUND'); const body=makeStoreZip(files);
  res.status(200); res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Length',String(body.length)); res.setHeader('Content-Disposition',`attachment; filename="aiway-project.zip"`); res.setHeader('Cache-Control','private, no-store, max-age=0'); return res.end(body);
}
async function downloadGeneratedFile(req, res) {
  const token = String(req.query?.token || '');
  const messageId = String(req.query?.messageId || '');
  const fileIndex = Number(req.query?.fileIndex);
  if (!messageId || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 7) throw new Error('UNAUTHORIZED');

  const originalAuthorization = req.headers.authorization;
  if (token) req.headers.authorization = `Bearer ${token}`;
  const user = await requireUser(req);
  req.headers.authorization = originalAuthorization;

  const { data: message, error } = await db().from('messages')
    .select('id,content,role')
    .eq('id', messageId).eq('user_id', user.id).eq('role', 'assistant').single();
  if (error || !message) throw new Error('FILE_NOT_FOUND');

  const file = extractDownloadableFiles(message.content)[fileIndex];
  if (!file) throw new Error('FILE_NOT_FOUND');
  const filename = safeDownloadFilename(file.name);
  const body = Buffer.from(file.content, 'utf8');
  const asciiName = filename.replace(/[^a-zA-Z0-9._-]/g, '-') || 'aiway-file.txt';

  res.status(200);
  res.setHeader('Content-Type', fileContentType(filename));
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(body);
}


const detectLanguage = text => /[\u0600-\u06FF]/.test(String(text || '')) ? 'ar' : 'en';
const formatSystemPrompt = (model, language) => `${language === 'ar' ? `أنت نموذج ${model.name || model.id} داخل منصة AiWay. أجب بالعربية الواضحة ما دام آخر طلب للمستخدم بالعربية، وإذا كتب بالإنجليزية فأجب بالإنجليزية.` : `You are ${model.name || model.id} inside the AiWay platform. Reply in English while the user's latest request is in English, and reply in Arabic when it is Arabic.`}
Maintain full continuity with all earlier messages in this conversation. Never ignore relevant context already provided.
Return polished Markdown only. Keep links valid and code syntactically complete. Do not expose partial markup or unfinished code.
For a downloadable code/text file, use a fenced block whose language is file-FILENAME, for example: \`\`\`file-index.html. Put only the complete file contents inside it.
When the user asks for a long code file, prefer a downloadable file block rather than an excessively long inline explanation.
For a PowerPoint, return one fenced pptx-json block containing valid JSON shaped as {"filename":"presentation.pptx","slides":[{"title":"...","bullets":["..."]}]}. Keep slide text concise and valid JSON with no comments.
Use short headings only when useful, fenced code blocks with a language, and tables only for real comparisons.`;

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  try {
    if (req.method === 'GET' && String(req.query?.action || '') === 'download-file') return await downloadGeneratedFile(req, res);
    if (req.method === 'GET' && String(req.query?.action || '') === 'download-project') return await downloadGeneratedProject(req, res);
    if (req.method !== 'POST') return res.status(400).json({ error: 'Invalid chat action' });
    const user = await requireUser(req);
    const { conversationId, modelId, messages, temperature = 0.7, webSearch = false, attachments = [], locale = 'ar' } = req.body || {};
    const uiLocale = String(locale).toLowerCase().startsWith('en') ? 'en' : 'ar';
    if (!conversationId || !modelId || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid chat request' });

    const [model, trialModelId] = await Promise.all([getModel(modelId), getTrialModelId()]);
    if (!model) throw new Error('MODEL_UNAVAILABLE');

    const supabase = db();
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('ai_tokens,trial_messages_remaining,has_purchased')
      .eq('id', user.id)
      .single();
    if (profileError) throw profileError;

    const purchased = Boolean(profile.has_purchased);
    if (!purchased && modelId !== trialModelId) throw new Error('MODEL_LOCKED');
    if (!purchased && webSearch) throw new Error('TRIAL_WEB_LOCKED');
    if (!purchased && Number(profile.trial_messages_remaining) <= 0) throw new Error('TRIAL_ENDED');
    if (Number(profile.ai_tokens) < 1) throw new Error('INSUFFICIENT_TOKENS');

    const cleaned = messages.slice(-40)
      .map(message => ({
        role: ['system', 'user', 'assistant'].includes(message.role) ? message.role : 'user',
        content: cleanText(message.content, 30000)
      }))
      .filter(message => message.content);

    const safeAttachments = Array.isArray(attachments) ? attachments.slice(0, 3).filter(a =>
      a && typeof a.name === 'string' && typeof a.type === 'string' &&
      typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:') && a.dataUrl.length <= 4_300_000
    ) : [];
    if (safeAttachments.length) {
      const lastIndex = [...cleaned].map(x => x.role).lastIndexOf('user');
      if (lastIndex >= 0) {
        const text = cleaned[lastIndex].content || 'حلل الملفات المرفقة';
        cleaned[lastIndex].content = [
          { type: 'text', text },
          ...safeAttachments.map(a => a.type.startsWith('image/')
            ? { type: 'image_url', image_url: { url: a.dataUrl } }
            : { type: 'file', file: { filename: cleanText(a.name, 150), file_data: a.dataUrl } })
        ];
      }
    }
    const latestUserText=[...cleaned].reverse().find(m=>m.role==='user')?.content;
    const language=detectLanguage(typeof latestUserText==='string'?latestUserText:latestUserText?.find?.(p=>p.type==='text')?.text);
    const safeMessages = [{ role: 'system', content: formatSystemPrompt(model, language) }, ...cleaned.filter(message=>message.role!=='system')];

    const lastUserMessage = [...cleaned].reverse().find(message => message.role === 'user');
    if (lastUserMessage) {
      const { error } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        user_id: user.id,
        role: 'user',
        content: typeof lastUserMessage.content === 'string' ? lastUserMessage.content : cleanText(lastUserMessage.content?.find?.(p => p.type === 'text')?.text || 'رسالة مع مرفقات', 30000),
        token_usage: { attachments: safeAttachments.map(a => ({ name: cleanText(a.name,150), type: a.type, size: Number(a.size||0) })) }
      });
      if (error) throw error;
    }

    const requestOpenRouter = selectedModelId => fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`,
        'X-OpenRouter-Title': 'AiWay',
        'X-OpenRouter-Metadata': 'enabled'
      },
      body: JSON.stringify({
        model: selectedModelId,
        messages: safeMessages,
        temperature: Number(temperature),
        stream: true,
        plugins: [webSearch ? { id: 'web' } : null, safeAttachments.some(a => a.type === 'application/pdf') ? { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } } : null].filter(Boolean),
        user: user.id
      })
    });
    let response = await requestOpenRouter(modelId);
    let activeModelId = modelId;
    let fallbackUsed = false;
    if (!response.ok && purchased) {
      const catalog = await (await import('./_lib.js')).getAvailableModels();
      const fallback = catalog.find(candidate => candidate.id !== modelId && candidate.family === model.family) || catalog.find(candidate => candidate.id !== modelId);
      if (fallback) { activeModelId = fallback.id; response = await requestOpenRouter(activeModelId); fallbackUsed = response.ok; }
    }
    if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 250)}`);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');

    let answer = '';
    let usage = {};
    let generationId = response.headers.get('x-generation-id') || '';
    let routedModelId = '';
    let routerMetadata = null;
    let routeMismatch = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') continue;
        try {
          const event = JSON.parse(raw);
          if (event.id && !generationId) generationId = event.id;
          if (event.model) routedModelId = event.model;
          if (event.openrouter_metadata) routerMetadata = event.openrouter_metadata;
          if (routedModelId && routedModelId !== activeModelId) {
            routeMismatch = { requested: activeModelId, routed: routedModelId };
          }
          const text = event.choices?.[0]?.delta?.content || '';
          if (text && !routeMismatch) {
            answer += text;
            res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
          }
          if (event.usage) usage = event.usage;
        } catch {}
      }
    }

    if (routeMismatch) throw new Error(`MODEL_ROUTE_MISMATCH:${routeMismatch.requested}:${routeMismatch.routed}`);

    const charge = chargeTokens(model.pricing, usage, webSearch);
    if (answer) {
      const { error: chargeError } = await supabase.rpc('consume_ai_tokens', {
        p_user_id: user.id,
        p_amount: charge.chargedTokens
      });
      if (chargeError) throw new Error('INSUFFICIENT_TOKENS');

      const { data: savedAssistant, error: saveAssistantError } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        user_id: user.id,
        role: 'assistant',
        content: answer,
        model_id: modelId,
        token_usage: {
          ...usage,
          ...charge,
          requestedModelId: modelId,
          activeModelId,
          fallbackUsed,
          routedModelId: routedModelId || activeModelId,
          generationId: generationId || null,
          routerMetadata
        }
      }).select('id').single();
      if (saveAssistantError) throw saveAssistantError;
      usage.savedMessageId = savedAssistant?.id || null;
      await supabase.from('conversations')
        .update({ model_id: modelId, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('user_id', user.id);
    }

    res.write(`data: ${JSON.stringify({
      type: 'done',
      usage,
      chargedTokens: charge.chargedTokens,
      requestedModelId: modelId,
      routedModelId: routedModelId || activeModelId,
      fallbackUsed,
      activeModelId,
      generationId: generationId || null,
      messageId: usage.savedMessageId || null
    })}\n\n`);
    res.end();
  } catch (error) {
    if (res.headersSent) {
      const details = errorDetails(error, uiLocale);
      res.write(`data: ${JSON.stringify({ type: 'error', error: details?.message || (uiLocale === 'ar' ? 'تعذر إكمال الطلب.' : 'Could not complete the request.'), code: details?.code || null })}\n\n`);
      return res.end();
    }
    return handleError(error, res, uiLocale === 'ar' ? 'تعذر إرسال رسالة المحادثة.' : 'Chat request failed.', uiLocale);
  }
}
