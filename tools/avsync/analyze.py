"""Measure recorded green marker onset against independently captured audio pulses."""
import argparse,json,subprocess
from pathlib import Path
import cv2,numpy as np
from scipy.io import wavfile
from scipy.signal import find_peaks,butter,sosfiltfilt
p=argparse.ArgumentParser();p.add_argument('movie',type=Path);p.add_argument('--assert-acceptance',action='store_true');args=p.parse_args()
movie=args.movie
probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(movie)]))
streams=probe['streams'];audio_start=float(next(s for s in streams if s['codec_type']=='audio').get('start_time',0))
wav=movie.with_suffix('.wav')
subprocess.run(['ffmpeg','-v','error','-y','-i',str(movie),'-vn','-ac','1','-ar','48000',str(wav)],check=True)
sr,data=wavfile.read(wav);data=data.astype(float)
# The fixture pulses occupy 800/1200Hz, its accompaniment 220..440Hz.
# WSOLA can attenuate an individual transient severely. Isolate the known
# pulse band with a zero-phase filter instead of losing it to a global 5%
# energy threshold. Detection remains independent of video/note timestamps.
signal=sosfiltfilt(butter(4,[650,1400],btype='bandpass',fs=sr,output='sos'),data)
energy=np.convolve(signal*signal,np.ones(240)/240,mode='same')
threshold=max(float(np.median(energy))*20,energy.max()*.0005,1)
peaks,_=find_peaks(energy,height=threshold,distance=sr*.18,prominence=threshold)
audio=peaks/sr+audio_start
pitch={}
for sample,t in zip(peaks,audio):
 segment=data[max(0,sample-512):sample+512]
 spectrum=np.abs(np.fft.rfft(segment*np.hanning(len(segment))))
 pitch[float(t)]=float(np.fft.rfftfreq(len(segment),1/sr)[np.argmax(spectrum)])
# Use actual decoded presentation timestamps, not an assumed constant frame rate.
frames=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(movie)]))['frames']
timestamps=[float(f['best_effort_timestamp_time']) for f in frames]
cap=cv2.VideoCapture(str(movie));previous=[];visual=[];i=0
while True:
 ok,frame=cap.read()
 if not ok:break
 frame=frame[250:735,560:1040]
 b,g,r=cv2.split(frame.astype(np.float32));mask=((g>110)&(g>r*1.6)&(g>b*1.5)).astype(np.uint8)
 n,_,stats,centers=cv2.connectedComponentsWithStats(mask)
 current=[tuple(centers[k]) for k in range(1,n) if stats[k,cv2.CC_STAT_AREA]>1500]
 for center in current:
  if not any(np.linalg.norm(np.array(center)-old)<45 for old in previous):visual.append({'t':timestamps[i],'xy':center})
 previous=current;i+=1
cap.release()
dedup=[]
# Each pad is visited once per 2 source seconds, i.e. at least 1 wall second
# at the tested maximum 2x. A burst can fragment/reappear under the combo
# overlay; count its first green onset, not a later fragment of the same hit.
for v in visual:
 if not any(v['t']-old['t']<.8 and np.linalg.norm(np.array(v['xy'])-old['xy'])<45 for old in dedup[-10:]):dedup.append(v)
visual=dedup
pairs=[]
for v in visual:
 if not len(audio):continue
 a=float(audio[np.argmin(np.abs(audio-v['t']))]);err=v['t']-a
 if abs(err)<.22:pairs.append({'video':v['t'],'audio':a,'error_ms':err*1000,'pitch_hz':pitch[a],'xy':v['xy']})
summary={'frames':i,'audio_pulses':len(audio),'visual_onsets':len(visual),'matched':len(pairs),'audio_peak':float(np.abs(data).max()),'pairs':pairs,'audio_times':audio.tolist(),'visual_times':visual}
phase_file=movie.parent/'phases.json'
if phase_file.exists() and pairs:
 phases=json.loads(phase_file.read_text());origin=phases[0]['wall'];groups=[]
 for idx,phase in enumerate(phases[:-1]):
  start=(phase['wall']-origin)/1000+1
  end=(phase.get('endWall',phases[idx+1]['wall'])-origin)/1000-.5
  if phase['phase']=='baseline_1x':end=min(end,7)
  if phase['phase'].startswith('before_rate_') and 'endWall' not in phase:end=min(end,(phase['wall']-origin)/1000+5.5)
  errors=[p['error_ms'] for p in pairs if start<=p['video']<=end]
  intervals=np.diff(audio[(audio>=start)&(audio<=end)])
  period=float(np.median(intervals)) if len(intervals) else None
  expected=.5/float(phase['phase'].split('_rate_')[1]) if '_rate_' in phase['phase'] else .5
  visible=[v for v in visual if start<=v['t']<=end]
  audio_count=int(np.count_nonzero((audio>=start)&(audio<=end)))
  distinct=len({p['audio'] for p in pairs if start<=p['video']<=end})
  pitches=[min(abs(p['pitch_hz']-800),abs(p['pitch_hz']-1200))<=100 for p in pairs if start<=p['video']<=end]
  if errors:groups.append({'audio_interval_sec':period,'expected_interval_sec':expected,'phase':phase['phase'],'n':len(errors),'visual_count':len(visible),'audio_count':audio_count,'distinct_audio_matches':distinct,'pitch_preserved_fraction':float(np.mean(pitches)),'median_ms':float(np.median(errors)),'p95_abs_ms':float(np.percentile(np.abs(errors),95)),'range_ms':[float(min(errors)),float(max(errors))]})
 summary['phases']=groups
if args.assert_acceptance:
 failures=[];by_name={g['phase']:g for g in summary.get('phases',[])}
 environment=movie.parent/'environment.json'
 if not environment.exists():failures.append('missing recording environment')
 else:
  env=json.loads(environment.read_text())
  if not env.get('compare') or env.get('noPitch') or env.get('graph') or env.get('outms') is not None:failures.append('diagnostic/modified playback is not product acceptance')
 for rate in ['0.5','0.75','1','2']:
  before=by_name.get('before_rate_'+rate);after=by_name.get('after50_rate_'+rate)
  if not before or not after:failures.append(f'{rate}: missing before/after phase');continue
  for group in [before,after]:
   if group['n']<20:failures.append(f"{group['phase']}: fewer than 20 onsets")
   if group['p95_abs_ms']>40:failures.append(f"{group['phase']}: P95 > 40ms")
   if group['pitch_preserved_fraction']<.95:failures.append(f"{group['phase']}: captured pulse pitch changed")
   if group['n']!=group['visual_count'] or group['n']!=group['distinct_audio_matches']:failures.append(f"{group['phase']}: unmatched/duplicate onset")
   if abs(group['n']-group['audio_count'])>1:failures.append(f"{group['phase']}: missing audio/visual events")
  if abs(before['median_ms']-after['median_ms'])>20:failures.append(f'{rate}: median drift > 20ms')
 summary['acceptance']={'passed':not failures,'failures':failures,'scope':'stable native-media phases before and after 50 interleaved operations; system capture, not physical output'}
if pairs:
 e=np.array([p['error_ms'] for p in pairs]);summary.update(median_ms=float(np.median(e)),p95_abs_ms=float(np.percentile(np.abs(e),95)))
movie.with_suffix('.analysis.json').write_text(json.dumps(summary,indent=2));print(json.dumps({k:v for k,v in summary.items() if k not in ['pairs','audio_times','visual_times']},indent=2))

if not len(audio) or not pairs: raise SystemExit('INVALID MEASUREMENT: missing captured pulses or visible marker onsets')
if args.assert_acceptance and failures:raise SystemExit('ACCEPTANCE FAILED: '+ '; '.join(failures))
