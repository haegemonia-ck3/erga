import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, changeSchema, bulkIssueUpdateSchema } from '../src/github.js';
import { Changes } from '../src/changes.js';
import { Store } from '../src/store.js';
import type { Config, Actor } from '../src/config.js';
const repository = 'team/mod';
const change = { repository, operation: 'update_issue_fields', number: 89, issue_field_values: [{field_id: 12, value: 'High'}] };
const actor: Actor = { userId: 'user', guildId: 'guild', channelId: 'thread', parentId: 'parent', roleIds: ['writer'] };
const policy = { guildId: 'guild', channelIds: ['parent'], readRoleIds: ['reader'], writeRoleIds: ['writer'], deleteRoleIds: [] } as Config;
const response = [{issue_field_id:12,issue_field_name:'Priority',data_type:'single_select',value:123,single_select_option:{name:'High'}},{issue_field_id:13,data_type:'text',value:'Keep this'}];
test('field writes use POST and option names, preserve other fields, and return confirmed values', async () => {
 const gh=new GitHub('test',[repository],async(url,init)=>{
  assert.equal(String(url),'https://api.github.com/repos/team/mod/issues/89/issue-field-values');
  assert.equal(init?.method,'POST');
  assert.equal((init?.headers as any)['X-GitHub-Api-Version'],'2026-03-10');
  assert.deepEqual(JSON.parse(init?.body as string),{issue_field_values:[{field_id:12,value:'High'}]});
  return Response.json(response);
 });
 const result=await gh.change(change);
 assert.equal(result.issue_field_values[1].value,'Keep this');
 assert.equal(result.issue_field_values[0].single_select_option.name,'High');
});
test('field updates reject empty arrays, duplicate fields and mixed bulk rows',()=>{
 assert.equal(changeSchema.safeParse({...change,issue_field_values:[]}).success,false);
 assert.equal(changeSchema.safeParse({...change,issue_field_values:[...change.issue_field_values,...change.issue_field_values]}).success,false);
 assert.equal(bulkIssueUpdateSchema.safeParse({repository,updates:[{number:89,issue_field_values:change.issue_field_values,assignees:['person']}]}).success,false);
});
test('bulk field writes obey roles and durable per-issue duplicate protection',async()=>{
 const store=new Store(':memory:');let writes=0;
 try{
 const gh=new GitHub('test',[repository],async()=>{writes++;return Response.json(response);});const changes=new Changes(policy,store,gh);
 await assert.rejects(changes.execute(change,{...actor,roleIds:['reader']},'denied'),/roles/);
 const batch={repository,updates:[89,88].map(number=>({number,issue_field_values:change.issue_field_values}))};
 assert.equal((await changes.executeBulk(batch,async()=>actor,'bulk')).applied,2);
 assert.equal((await changes.executeBulk(batch,async()=>actor,'bulk')).applied,2);
 assert.equal(writes,2);
 }finally{store.close();}
});
test('unconfirmed field result is unknown and cannot be repeated',async()=>{
 const store=new Store(':memory:');let writes=0;
 try{
 const gh=new GitHub('test',[repository],async()=>{writes++;return Response.json([]);});const changes=new Changes(policy,store,gh);
 await assert.rejects(changes.execute(change,actor,'unknown'),/inconclusive/);
 await assert.rejects(changes.execute(change,actor,'unknown'),/unknown/);
 assert.equal(writes,1);
 }finally{store.close();}
});
