import { allowMethods,json,MODELS } from './_lib.js';
export default function handler(req,res){if(!allowMethods(req,res,['GET']))return;return json(res,200,{models:MODELS});}
