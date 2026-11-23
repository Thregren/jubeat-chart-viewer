import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../jubeat_viewer/player/static/app-radar.js', import.meta.url), 'utf8');

test('radar reuses SVG nodes and updates only the title for metadata changes', () => {
  const panel = { open: false, addEventListener() {} };
  const song = {};
  const button = { addEventListener() {} };
  let plots = 0, analyses = 0, titles = 0;
  Object.defineProperty(song,'textContent',{set(value){ titles++;song.title=value; }});
  const node = () => ({ append() {}, setAttribute() {} });
  const plot = { ...node(), replaceChildren() { plots++; } };
  const elements = { radarPanel:panel, radarPlot:plot, radarSong:song, btnRadar:button, radarClose:button };
  const document = { getElementById: id => elements[id], createElementNS: node };
  const A = { state: { song:{title:'Song'}, chart:{}, notes:[{}], chartMeta:{code:'EXT',level:10} } };
  const window = {
    JubeatApp:A, JubeatRadarReferences:{},
    JubeatRadar:{
      axes:Array(6).fill(['EN','CN']),
      analyze(){ analyses++;return { values:[20,30,40,50,60,70] }; },
    },
  };
  vm.runInNewContext(source,{window,document});
  A.updateRadar();
  assert.equal(analyses,0);
  panel.open=true;
  A.updateRadar();
  const initialPlots=plots, initialTitles=titles;
  assert.equal(analyses,1);
  assert.equal(song.title,'Song · EXT · Lv. 10');
  A.updateRadar();
  assert.equal(plots,initialPlots);
  assert.equal(titles,initialTitles);

  A.state.chartMeta={code:'EXT',level:9};
  A.updateRadar();
  assert.equal(plots,initialPlots);
  assert.equal(titles,initialTitles+1);
  assert.equal(song.title,'Song · EXT · Lv. 9');
  A.state.notes=[{}];
  A.updateRadar();
  assert.equal(analyses,2);
  assert.equal(plots,initialPlots+1);

  A.clearRadar();
  assert.equal(A.radarResult(),null);
  assert.equal(button.disabled,true);
  assert.equal(song.title,'');
  A.clearRadar();
  assert.equal(plots,initialPlots+2);
  A.updateRadar();
  assert.equal(analyses,2);
  assert.equal(plots,initialPlots+3);
  assert.equal(song.title,'Song · EXT · Lv. 9');
});
