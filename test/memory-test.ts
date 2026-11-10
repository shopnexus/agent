import assert from 'node:assert/strict';
import { ConversationContextService, StoredConversationTurn } from '../src/memory/conversation-context.service';
const turn=(ordinal:number,text:string):StoredConversationTurn=>({ordinal,status:'SUCCEEDED',messages:[
  {ordinal:0,role:'USER',blocks:[{ordinal:0,kind:'TEXT',text,isTerminal:false}]},
  {ordinal:1,role:'ASSISTANT',blocks:[{ordinal:0,kind:'TEXT',text:`answer ${text}`,isTerminal:true}]},
]});
const context=new ConversationContextService();
const restored=context.build([turn(1,'new'),turn(0,'old')],2);
assert.deepEqual(restored,[{role:'user',content:[{text:'new'}]},{role:'assistant',content:[{text:'answer new'}]}]);
assert.equal(context.build([turn(1,'new')],1).length,0);
assert.equal(context.build([turn(1,'x'.repeat(2000))],40,1000).length,0);
console.log('Bounded conversation history tests passed');
