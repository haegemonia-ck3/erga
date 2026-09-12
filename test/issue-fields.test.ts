import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.js';

const repository = 'team/mod';
const priority = { issue_field_id: 33208318, issue_field_name: 'Priority', data_type: 'single_select', value: 58108555, single_select_option: { id: 58108555, name: 'Low', color: 'green' } };
test('issue lists and individual issues preserve Priority field names and selected values', async () => {
  const issue = { number: 86, title: 'Example', labels: [], issue_field_values: [priority] };
  const gh = new GitHub('test', [repository], async url => Response.json(String(url).includes('/issues/86?') ? issue : [issue, { number: 87, labels: [], issue_field_values: [] }]));
  for (const resource of ['issues', 'issue'] as const) {
    const result = await gh.query({ repository, resource, ...(resource === 'issue' ? { number: 86 } : {}) }) as any;
    const item = Array.isArray(result.data) ? result.data[0] : result.data;
    assert.equal(item.issue_field_values[0].issue_field_name, 'Priority');
    assert.equal(item.issue_field_values[0].single_select_option.name, 'Low');
    assert.equal(item.issue_field_values[0].value, 58108555);
    if (Array.isArray(result.data)) assert.deepEqual(result.data[1].issue_field_values, []);
  }
});
test('search results preserve fields and distinguish missing data from unset fields', async () => {
  const gh = new GitHub('test', [repository], async () => Response.json({ total_count: 2, incomplete_results: false, items: [
    { number: 86, repository_url: `https://api.github.com/repos/${repository}`, issue_field_values: [priority] },
    { number: 87, repository_url: `https://api.github.com/repos/${repository}` },
  ] }));
  const result = await gh.query({ repository, resource: 'search', text: 'example' }) as any;
  assert.equal(result.data[0].issue_field_values[0].single_select_option.name, 'Low');
  assert.equal('issue_field_values' in result.data[1], false);
});
test('dedicated issue field reads enforce repository scope, require number, and paginate', async () => {
  let seen = '';
  const gh = new GitHub('test', [repository], async url => { seen = String(url); return Response.json([priority]); });
  await assert.rejects(gh.query({ repository: 'other/private', resource: 'issue_fields', number: 86 }), /outside/);
  await assert.rejects(gh.query({ repository, resource: 'issue_fields' }), /number/);
  const result = await gh.query({ repository, resource: 'issue_fields', number: 86, page: 2 }) as any;
  assert.equal(seen, 'https://api.github.com/repos/team/mod/issues/86/issue-field-values?per_page=30&page=2');
  assert.equal(result.data[0].single_select_option.name, 'Low');
});
