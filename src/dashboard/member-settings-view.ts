/**
 * The Member settings panel (#1459) as browser code: `memberSettingsPanel(panel)` renders what `/api/member-settings`
 * answers. The dashboard client embeds it, and so supplies `t`, `e` and `label`.
 */
export const memberSettingsView = `
const memberLevelNames = { environment: 'Environment', machine: 'This machine', team: 'Team', 'http-team': 'HTTP team repo', default: 'Default' };
function memberScopeName(m) { return m.scope==='user'?'User config':m.scope==='self'?'This repo':'This workspace'; }
function memberLevelName(m, source) { return source.level==='scope'?(source.file===m.machineFile?'User config':memberScopeName(m)):memberLevelNames[source.level]; }
function memberLevel(m, source) { return '<span class="level level-'+e(source.level)+'">'+label(memberLevelName(m,source))+'</span>'; }
function memberValue(value) { return '<code data-verbatim>'+e(typeof value==='string'?value:JSON.stringify(value))+'</code>'; }
function memberPath(m, file) { const prefix=m.home+m.machineFile.charAt(m.home.length); return file&&m.home&&file.startsWith(prefix)?'~'+file.slice(m.home.length):file; }
function memberWhere(m, source) { const where=source.variable||(source.level==='team'?'teamai.yaml':memberPath(m,source.file)); return where?'<small data-verbatim>'+e(where)+'</small>':''; }
function memberAlso(m, row) {
 const also=row.below.map(b=>'<li>'+memberLevel(m,b)+' '+memberValue(b.value)+'</li>').concat(row.unused.map(u=>'<li class="muted">'+memberLevel(m,u)+' '+memberValue(u.value)+' <small>'+label('not used')+'</small></li>'));
 return also.length?'<ul class="member-also">'+also.join('')+'</ul>':'<span class="muted">—</span>';
}
function memberSettingsPanel(m) {
 if(!m.configured)return '';
 const heads=['Setting','In effect','Set by','Also set'];
 const rows=m.rows.map(r=>'<tr><td data-label="'+label(heads[0])+'"><code data-verbatim>'+e(r.key)+'</code></td><td data-label="'+label(heads[1])+'">'+memberValue(r.value)+'</td><td data-label="'+label(heads[2])+'">'+memberLevel(m,r.source)+memberWhere(m,r.source)+'</td><td data-label="'+label(heads[3])+'">'+memberAlso(m,r)+'</td></tr>').join('');
 const order=['Environment',memberScopeName(m),...(m.scope==='user'?[]:['This machine']),'Team','Default'].map(label).join(' › ');
 return '<section class="panel member-settings" aria-labelledby="member-settings-title"><div class="panelhead"><h2 id="member-settings-title">'+label('Member settings')+'</h2><span class="tag">'+label('The first level that sets a setting wins')+label(': ')+order+'</span></div>'
  +(rows?'<div class="table-scroll"><table class="member-settings-table"><thead><tr>'+heads.map(h=>'<th>'+label(h)+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>'
   :'<div class="empty" role="status">'+label('No level sets a member setting here, so each one has its default.')+'</div>')
  +(m.unread.length?'<p class="member-unread amber">'+label('Not read')+label(': ')+'<span data-verbatim>'+m.unread.map(e).join(', ')+'</span><small>'+label('Without a user-scope install, only member settings are read from')+' <span data-verbatim>'+e(memberPath(m,m.machineFile))+'</span></small></p>':'')
  +'</section>';
}
`;
