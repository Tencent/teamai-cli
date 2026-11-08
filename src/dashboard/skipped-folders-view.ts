/**
 * Folders of the team repo this teamai cannot read yet (#1791), as browser
 * code. `skippedFoldersPanel(folders)` heads the Resources page with each
 * folder, its kind and marker; `skippedFoldersNotice(folders)` tells the
 * Overview how many there are and links to that list. Both render nothing
 * when no folder is skipped. The dashboard client embeds it after the handoff
 * view, and so supplies `e`, `label`, `number`, `link` and `command`.
 */
export const skippedFoldersView = `
const skippedFoldersFix = 'teamai update && teamai pull';
function skippedFoldersPanel(folders) {
 if(!folders||!folders.length)return '';
 return '<section class="panel skipped-folders" aria-labelledby="skipped-folders-title"><div class="panelhead"><h2 id="skipped-folders-title"><span class="amber" aria-hidden="true">⚠</span> '+label('Skipped folders')+' <span class="count">'+number(folders.length)+'</span></h2><span class="label">'+label('This teamai cannot read these folder types yet')+'</span></div>'
  +'<p>'+label('Nothing in them reaches your agents, and push leaves them alone. Everything else in the team repo is delivered as usual.')+'</p>'
  +'<div class="table-scroll"><table class="session-table skipped-table"><thead><tr>'+['FOLDER','TYPE','MARKER'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +folders.map(f=>'<tr><td data-verbatim>'+e(f.path)+'</td><td data-label="'+label('TYPE')+'">'+label(f.kind)+'</td><td data-label="'+label('MARKER')+'"><code data-verbatim>'+e(f.marker)+'</code></td></tr>').join('')
  +'</tbody></table></div><p class="hint">'+label('Update teamai, then pull again to receive them:')+'</p>'+command(skippedFoldersFix)+'</section>';
}
function skippedFoldersNotice(folders) {
 if(!folders||!folders.length)return '';
 return '<div class="error-panel skipped-notice" role="status"><p><strong><span class="amber" aria-hidden="true">⚠</span> '+number(folders.length)+' '+label(folders.length===1?'team folder is skipped':'team folders are skipped')+'</strong> · '+label('This teamai cannot read their type yet, so nothing in them reaches your agents.')+'</p>'
  +command(skippedFoldersFix)+' '+link('resources','View skipped folders')+'</div>';
}
`;
