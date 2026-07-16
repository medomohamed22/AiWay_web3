import {allowMethods,cleanText,db,handleError,json,requireUser} from './_lib.js';

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST','PATCH','DELETE']))return;
  try{
    const user=await requireUser(req),s=db();

    if(req.method==='GET'){
      const id=String(req.query?.id||'');
      if(id){
        const {data:conversation,error:conversationError}=await s.from('conversations')
          .select('*').eq('id',id).eq('user_id',user.id).single();
        if(conversationError)throw conversationError;

        const {data:messages,error:messagesError}=await s.from('messages')
          .select('*').eq('conversation_id',id).eq('user_id',user.id)
          .order('created_at',{ascending:true});
        if(messagesError)throw messagesError;

        const messageIds=(messages||[]).map(message=>message.id);
        let images=[];
        if(messageIds.length){
          const {data,error}=await s.from('generated_images').select('*')
            .eq('conversation_id',id).eq('user_id',user.id)
            .in('message_id',messageIds).order('created_at',{ascending:true});
          if(error)throw error;
          images=data||[];
        }

        const imagesByMessage=new Map();
        for(const image of images){
          if(image.storage_path){
            const {data:signed,error:signedError}=await s.storage.from('generated-images')
              .createSignedUrl(image.storage_path,3600);
            if(!signedError&&signed?.signedUrl)image.display_url=signed.signedUrl;
          }
          const list=imagesByMessage.get(image.message_id)||[];
          list.push(image);
          imagesByMessage.set(image.message_id,list);
        }

        conversation.messages=(messages||[]).map(message=>({
          ...message,
          generated_images:imagesByMessage.get(message.id)||[]
        }));
        return json(res,200,{conversation});
      }

      const {data,error}=await s.from('conversations')
        .select('id,title,model_id,updated_at,created_at')
        .eq('user_id',user.id).order('updated_at',{ascending:false});
      if(error)throw error;
      return json(res,200,{conversations:data});
    }

    if(req.method==='POST'){
      const {data,error}=await s.from('conversations').insert({
        user_id:user.id,
        title:cleanText(req.body?.title||'New chat',80),
        model_id:cleanText(req.body?.modelId,120)
      }).select('*').single();
      if(error)throw error;
      return json(res,201,{conversation:data});
    }

    const id=String(req.body?.id||req.query?.id||'');
    if(!id)return json(res,400,{error:'Conversation id required'});
    if(req.method==='PATCH'){
      const patch={};
      if(req.body?.title!==undefined)patch.title=cleanText(req.body.title,80);
      if(req.body?.modelId!==undefined)patch.model_id=cleanText(req.body.modelId,120);
      const {data,error}=await s.from('conversations').update(patch)
        .eq('id',id).eq('user_id',user.id).select('*').single();
      if(error)throw error;
      return json(res,200,{conversation:data});
    }

    const {error}=await s.from('conversations').delete().eq('id',id).eq('user_id',user.id);
    if(error)throw error;
    return json(res,200,{deleted:true});
  }catch(e){
    return handleError(e,res,'Conversation operation failed');
  }
}
