// Build only public advertisement data, never application source or models.
const fs=require('node:fs');
const path=require('node:path');
const {build}=require('./build-ad-feed.cjs');
const root=path.resolve(__dirname,'..');
const input=path.resolve(process.argv[2] || path.join(root,'assets/ad'));
// A dedicated build directory avoids publishing stale or unrelated local files.
// Keep this destination fixed so cleanup cannot target a caller's source folder.
const output=path.join(root,'dist/ad-pages');
const feed=build(input);
if (input === output || input.startsWith(output+path.sep)) throw Error('Advertisement input must be outside the Pages build directory');
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(path.join(output,'ads'),{recursive:true});
fs.writeFileSync(path.join(output,'ads/manifest.json'),JSON.stringify(feed,null,2)+'\n');
for(const ad of feed.ads)fs.copyFileSync(path.join(input,ad.image),path.join(output,'ads',ad.image));
fs.writeFileSync(path.join(output,'.nojekyll'),'');
fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>V-Translate public advertisement assets</title><h1>V-Translate advertisement assets</h1><p>This site supplies public banner images and destinations to V-Translate.</p><p><a href="ads/manifest.json">Advertisement manifest</a></p></html>\n');
console.log(`Prepared ${feed.ads.length} public ads in ${output}`);
