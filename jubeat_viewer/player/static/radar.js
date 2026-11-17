/* Screenshot-calibrated chart tendencies. Estimates are not KONAMI's formula.
 * Pure module: normalized source notes, unaffected by playback rate or mirroring.
 * Reference ring = 100; scores can exceed it. See radar-analysis report. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.JubeatRadar=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const axes=[['NOTES','物量'],['PEAK','尖峰'],['SLIDE','钢琴'],['HAND-TRIP','出张'],['HOLD','长押'],['CHORD','同时押']];
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  function normalize(input){return (Array.isArray(input)?input:[]).filter(n=>n&&finite(n.t)&&Number.isInteger(n.index)&&n.index>=0&&n.index<16&&(n.endT==null||finite(n.endT)&&n.endT>=n.t)).slice().sort((a,b)=>a.t-b.t||a.index-b.index);}
  // Two independent 32-bit accumulators; relative millisecond timing, head pad,
  // hold duration and tail direction all participate. Never match on title alone.
  function fingerprint(notes){if(!notes.length)return '';const origin=notes[0].t;let a=2166136261,b=0x9e3779b9;const feed=s=>{for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),16777619)>>>0;b=Math.imul(b^s.charCodeAt(i),0x85ebca6b)>>>0;}};
    for(const n of notes)feed(`${Math.round((n.t-origin)*1000+1e-6)},${n.index},${n.endT==null?'-':Math.round((n.endT-origin)*1000+1e-6)},${n.tailTip??'-'};`);
    return `${notes.length}-${a.toString(16)}-${b.toString(16)}`;
  }
  function analyze(input,references={}){
    const notes=normalize(input);if(!notes.length)return {values:axes.map(()=>0),source:'empty',features:{},reference:null};
    const gs=[],ends=[],times=[];let last=notes[0].t,holds=0;
    for(const n of notes){let g=gs[gs.length-1];if(!g||n.t-g.t>.001)gs.push(g={t:n.t,ns:[]});g.ns.push(n);times.push(n.t);last=Math.max(last,n.t);if(n.endT!=null){holds++;ends.push(n.endT);times.push(n.endT);last=Math.max(last,n.endT);}}
    const span=Math.max(1,last-notes[0].t);times.sort((a,b)=>a-b);ends.sort((a,b)=>a-b);
    let peak=0,left=0;for(let right=0;right<times.length;right++){while(times[right]-times[left]>=1-1e-7)left++;peak=Math.max(peak,right-left+1);}
    let chordNotes=0,chord3=0,trip4=0,tripSide=0,slide=0;
    for(let i=0;i<gs.length;i++){const g=gs[i],size=g.ns.length;if(size>1)chordNotes+=size;if(size===3)chord3+=size;
      for(const side of [0,1])if(g.ns.filter(n=>(n.index%4<2?0:1)===side).length>=4)trip4++;
      if(i>0&&g.t-gs[i-1].t<=.170+1e-7&&size>=2&&g.ns.every(n=>(n.index%4<2)===(g.ns[0].index%4<2)))tripSide+=size;
      if(size!==1)continue;
      for(const dir of [1,-1,4,-4]){let j=i,prev=g.ns[0];while(j+1<gs.length&&j-i<3){const next=gs[j+1];if(next.ns.length!==1||next.t-gs[j].t>1/6+1e-7)break;const n=next.ns[0];if(n.index-prev.index!==dir||Math.abs(dir)===1&&(n.index>>2)!==(prev.index>>2))break;j++;prev=n;}if(j-i>=2)slide+=j-i;}
    }
    // Sweep hold starts/ends rather than quadratic note × hold comparisons.
    const starts=notes.filter(n=>n.endT!=null).map(n=>n.t);let si=0,ei=0,heldHits=0;
    for(const n of notes){while(si<starts.length&&starts[si]<n.t-.001)si++;while(ei<ends.length&&ends[ei]<=n.t+.001)ei++;heldHits+=Math.max(0,si-ei);}
    const raw=[.13632444*(notes.length+holds)/span,.00346954*peak*peak,1.15237138*(slide/span)**2,(.44977575*tripSide+3.11863587*trip4+.31832805*heldHits)/span,(1.34879987*holds+.42081863*heldHits)/span,1.21178688*chordNotes/notes.length+.17338621*chord3/span];
    const estimate=raw.map(v=>Math.max(0,v*100));const key=fingerprint(notes),ref=Object.prototype.hasOwnProperty.call(references,key)?references[key]:null;
    const values=ref?estimate.map((v,i)=>finite(ref.values[i])?ref.values[i]*100:v):estimate;
    return {values,estimate,source:ref?(ref.values.every(finite)?'reference':'mixed'):'estimated',reference:ref,fingerprint:key,features:{heads:notes.length,holds,judgments:notes.length+holds,span,peak,chordNotes,chord3,trip4,tripSide,slide,heldHits}};
  }
  return {axes,normalize,fingerprint,analyze};
});
