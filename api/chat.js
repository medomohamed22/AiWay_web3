import { allowMethods, chargeTokens, cleanText, db, getModel, getTrialModelId, handleError, requireUser } from './_lib.js';

const detectLanguage = text => /[\u0600-\u06FF]/.test(String(text || '')) ? 'ar' : 'en';
const formatSystemPrompt = (model, language) => `${language === 'ar' ? `أنت نموذج ${model.name || model.id} داخل منصة AiWay. أجب بالعربية الواضحة ما دام آخر طلب للمستخدم بالعربية، وإذا كتب بالإنجليزية فأجب بالإنجليزية.` : `You are ${model.name || model.id} inside the AiWay platform. Reply in English while the user's latest request is in English, and reply in Arabic when it is Arabic.`}
Maintain full continuity with all earlier messages in this conversation. Never ignore relevant context already provided.
Return polished Markdown only. Keep links valid and code syntactically complete. Do not expose partial markup or unfinished code.
For a downloadable code/text file, use a fenced block whose language is file-FILENAME, for example: \`\`\`file-index.html. Put only the complete file contents inside it.
When the user asks for a long code file, prefer a downloadable file block rather than an excessively long inline explanation.
For a PowerPoint, return one fenced pptx-json block containing valid JSON shaped as {"filename":"presentation.pptx","slides":[{"title":"...","bullets":["..."]}]}. Keep slide text concise and valid JSON with no comments.
Use short headings only when useful, fenced code blocks with a language, and tables only for real comparisons.`;

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const user = await requireUser(req);
    const { conversationId, modelId, messages, temperature = 0.7, webSearch = false, attachments = [] } = req.body || {};
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

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`,
        'X-OpenRouter-Title': 'AiWay'
      },
      body: JSON.stringify({
        model: modelId,
        messages: safeMessages,
        temperature: Number(temperature),
        stream: true,
        plugins: [webSearch ? { id: 'web' } : null, safeAttachments.some(a => a.type === 'application/pdf') ? { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } } : null].filter(Boolean),
        user: user.id
      })
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 250)}`);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');

    let answer = '';
    let usage = {};
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
          const text = event.choices?.[0]?.delta?.content || '';
          if (text) {
            answer += text;
            res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
          }
          if (event.usage) usage = event.usage;
        } catch {}
      }
    }

    const charge = chargeTokens(model.pricing, usage, webSearch);
    if (answer) {
      const { error: chargeError } = await supabase.rpc('consume_ai_tokens', {
        p_user_id: user.id,
        p_amount: charge.chargedTokens
      });
      if (chargeError) throw new Error('INSUFFICIENT_TOKENS');

      await supabase.from('messages').insert({
        conversation_id: conversationId,
        user_id: user.id,
        role: 'assistant',
        content: answer,
        model_id: modelId,
        token_usage: { ...usage, ...charge }
      });
      await supabase.from('conversations')
        .update({ model_id: modelId, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('user_id', user.id);
    }

    res.write(`data: ${JSON.stringify({ type: 'done', usage, chargedTokens: charge.chargedTokens })}\n\n`);
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      return res.end();
    }
    return handleError(error, res, 'Chat request failed');
  }
}
