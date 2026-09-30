
(() => {
  // ================================================================
  // 1. データ定義
  // ================================================================
  const SYM = {
    S7:{html:'<b class="s7">7</b>',name:'セブン'},
    BAR:{html:'<b class="bar">BAR</b>',name:'BAR'},
    WML:{html:'<span class="emo">🍉</span>',name:'スイカ'},
    GRP:{html:'<span class="emo">🍇</span>',name:'ぶどう'},
    BEL:{html:'<span class="emo">🔔</span>',name:'ベル'},
    CHE:{html:'<span class="emo">🍒</span>',name:'チェリー'},
    RPL:{html:'<b class="rpl">REPLAY</b>',name:'リプレイ'}
  };
  const PAY = {S7:0, BAR:0, WML:10, BEL:14, GRP:8, CHE:2, RPL:0}; // 1ラインあたりの配当（7・BARはAT突入）
  const AT_GOAL = {S7:300, BAR:100};  // ATの払い出し目標枚数
  const BET = 3;

  // リール配列（21コマ）。ジャグラーの配列をもとに、ピエロの位置をスイカに置き換えたもの。
  // 配列表と同じく「上が21番、下が1番」の順で、上から並べている。
  // 横3ラインでは、ぶどう・リプレイはどの押し順・タイミングでも必ず揃い、
  // チェリー・ベル・スイカ・7・BARは狙って押す必要がある（実機と同じ性格）
  const STRIPS = [
    'BEL S7 RPL GRP RPL GRP BAR CHE GRP RPL GRP S7 WML GRP RPL GRP CHE BAR GRP RPL GRP',
    'RPL S7 GRP CHE RPL BEL GRP CHE RPL BAR GRP CHE RPL BEL GRP CHE RPL BAR GRP CHE WML',
    'GRP S7 BAR BEL RPL GRP WML BEL RPL GRP WML BEL RPL GRP WML BEL RPL GRP WML BEL RPL'
  ].map(s => s.split(' '));
  const N = STRIPS[0].length;

  // 有効ライン：上段・中段・下段の3ライン（各リールの行番号 0=上 1=中 2=下）
  const LINES = [[1,1,1],[0,0,0],[2,2,2]];

  // 内部抽選テーブル（65536分率）。残りはハズレ
  const TABLE = [
    ['GRP', 10923], // 1/6
    ['RPL',  8978], // 約1/7.3
    ['CHE',  1820], // 約1/36
    ['BEL',    60], // 約1/1092
    ['WML',    60], // 約1/1092
    ['BAR',   218], // 約1/300
    ['S7',    164]  // 約1/400
  ];
  // 設定1〜6：7とBARの確率（65536分率）を変えて出玉率を調整。
  // 出玉率は「ランプ点灯後に7・BARを揃え、ATを消化した場合」のシミュレーション値
  const SETTINGS = {
    1:{S7:117,  BAR:234,  rtp:80},
    2:{S7:184,  BAR:369,  rtp:90},
    3:{S7:310,  BAR:620,  rtp:105},
    4:{S7:450,  BAR:900,  rtp:120},
    5:{S7:950,  BAR:1900, rtp:150},
    6:{S7:3500, BAR:7000, rtp:200}
  };
  function applySetting(n){
    TABLE.find(t => t[0] === 'S7')[1] = SETTINGS[n].S7;
    TABLE.find(t => t[0] === 'BAR')[1] = SETTINGS[n].BAR;
  }

  // AT中の抽選テーブル：ぶどう高確率（ぶどうはどの押し順でも必ず揃う）
  const AT_TABLE = [
    ['GRP', 54554], ['RPL', 8978], ['CHE', 1820]
  ];
  const NAVI = {}; // 押し順ナビは廃止
  const CARRY_OVER = ['S7','BAR']; // 取りこぼすと持ち越す役
  const MAX_SLIDE = 4;             // 最大すべりコマ数
  const SPEED = 0.018;             // 回転速度（コマ/ms）

  const mod = (a, n) => ((a % n) + n) % n;
  // リールreelの停止位置posで、row行目に見えている図柄
  const symAt = (reel, pos, row) => STRIPS[reel][(pos + row) % N];

  // ================================================================
  // 2. 内部抽選
  // ================================================================
  function lottery(table = TABLE){
    let r = Math.floor(Math.random() * 65536);
    for(const [flag, weight] of table){
      if(r < weight) return flag;
      r -= weight;
    }
    return null; // ハズレ
  }

  // ================================================================
  // 3. 役の判定
  //    stops = 各リールの停止位置（未停止は null）
  // ================================================================
  function grade(stops){
    const wins = [];
    LINES.forEach(line => {
      const s = [0,1,2].map(c => symAt(c, stops[c], line[c]));
      if(s[0] === s[1] && s[1] === s[2] && s[0] !== 'CHE') wins.push({key:s[0], line, cols:[0,1,2]});
      else if(s[0] === 'CHE') wins.push({key:'CHE', line, cols:[0]});
    });
    return wins;
  }

  // 当選していない役が成立してしまっているか（＝蹴飛ばし失敗）
  function violates(stops, flag){
    // チェリーは左リールだけで成立するので、左が止まった時点で判定
    if(stops[0] !== null && flag !== 'CHE' &&
       LINES.some(line => symAt(0, stops[0], line[0]) === 'CHE')) return true;
    if(stops.every(p => p !== null)) return grade(stops).some(w => w.key !== flag);
    return false;
  }

  // ================================================================
  // 4. リール制御（先読み）
  //    value(stops, flag) = この停止状態から先、プレイヤーが
  //    ランダムなタイミングで押したときに当選役が揃う期待値。
  //    蹴飛ばし失敗は -1。結果はメモして「制御テーブル」として再利用する。
  // ================================================================
  const memo = new Map();
  function value(stops, flag){
    if(violates(stops, flag)) return -1;
    const rest = [0,1,2].filter(i => stops[i] === null);
    if(rest.length === 0) return grade(stops).some(w => w.key === flag) ? 1 : 0;

    const key = flag + ':' + stops.join(',');
    if(memo.has(key)) return memo.get(key);

    // 次は「残っている一番左のリール」を押すと仮定し（順押し前提）、
    // どの位置で押されても良いように全21通りを試して平均する
    const reel = rest[0];
    let sum = 0;
    for(let base = 0; base < N; base++) sum += decideStop(stops, reel, base, flag).v;
    const v = sum / N;
    memo.set(key, v);
    return v;
  }

  // STOPを押した位置baseから0〜4コマすべらせた候補のうち、最も良いものを選ぶ
  // 同じ評価なら、すべりが少ない方を優先
  function decideStop(stops, reel, base, flag){
    let best = null;
    for(let k = 0; k <= MAX_SLIDE; k++){
      const pos = mod(base - k, N);
      const next = stops.slice(); next[reel] = pos;
      const v = value(next, flag);
      if(!best || v > best.v + 1e-9) best = {slide:k, pos, v};
    }
    return best;
  }

  // ================================================================
  // 5. 演出テーブル
  //    当選役ごとに液晶演出の出現率を変える。
  //    「どの演出が出たら何の期待度が高いか」はここで決まる
  // ================================================================
  const BIG = ['S7','BAR'];
  // 内部キーは以前のまま（walk=通常 / meteor=ハート連打 / chest=ギフト / hokuto=ランキング）
  const SCENES = {
    walk:        '通常配信',
    meteor:      'ハート連打',
    meteorGold:  '金ハート連打',
    chestBlue:   'ギフト（青）',
    chestGreen:  'ギフト（緑）',
    chestRed:    'ギフト（赤）',
    chestRainbow:'ギフト（虹）',
    hokuto:      'ランキング急上昇'
  };
  const SCENE_TABLE = {
    null:{walk:90, meteor:6,  chestBlue:3, chestGreen:1},
    GRP: {walk:88, meteor:7,  chestBlue:4, chestGreen:1},
    RPL: {walk:88, meteor:7,  chestBlue:4, chestGreen:1},
    BEL: {walk:35, meteor:15, meteorGold:10, chestBlue:8,  chestGreen:15, chestRed:15, hokuto:2},
    CHE: {walk:45, meteor:20, meteorGold:5,  chestBlue:10, chestGreen:12, chestRed:6,  hokuto:2},
    WML: {walk:30, meteor:15, meteorGold:10, chestBlue:8,  chestGreen:15, chestRed:15, hokuto:7},
    BIG: {walk:30, meteor:10, meteorGold:12, chestBlue:3,  chestGreen:8,  chestRed:15, chestRainbow:7, hokuto:15}
  };
  const sceneRow = flag => SCENE_TABLE[BIG.includes(flag) ? 'BIG' : String(flag)];
  function pickScene(flag){
    const row = sceneRow(flag);
    let r = Math.random() * Object.values(row).reduce((a,b)=>a+b, 0);
    for(const [k,w] of Object.entries(row)){ if(r < w) return k; r -= w; }
    return 'walk';
  }
  // 各演出が出たときの「7・BAR当選の期待度」を抽選テーブルから計算（ベイズの定理）
  let EXPECT, GEKI_EXPECT;
  function calcExpect(){ EXPECT = calcSceneExpect(); GEKI_EXPECT = calcGekiExpect(); }
  const calcSceneExpect = () => {
    const pFlag = {null: 1 - TABLE.reduce((a,t)=>a+t[1],0)/65536};
    TABLE.forEach(([k,w]) => pFlag[k] = w/65536);
    const res = {};
    for(const scn of Object.keys(SCENES)){
      let all = 0, big = 0;
      for(const f of Object.keys(pFlag)){
        const flag = f === 'null' ? null : f, row = sceneRow(flag);
        const p = pFlag[f] * (row[scn] || 0) / Object.values(row).reduce((a,b)=>a+b,0);
        all += p; if(BIG.includes(flag)) big += p;
      }
      res[scn] = all ? big/all : 0;
    }
    return res;
  };
  const PRE_PEKA = 0.25; // 先ペカの割合（残りは3つ目のSTOPで後ペカ）

  // 激アツ演出（全画面カットイン）の発生率。第2停止で発生
  const GEKI_RATE = {BIG:.35, WML:.06, BEL:.06, CHE:.03, other:.003};

  // カットイン（リール回転開始時）：緑 < 赤 < 虹（虹は7・BAR確定）
  const CUTIN_TABLE = {
    BIG:  {green:.12, red:.30, rainbow:.15},
    WML:  {green:.20, red:.12},
    BEL:  {green:.20, red:.12},
    CHE:  {green:.15, red:.05},
    other:{green:.03, red:.005}
  };
  const cutRow = f => CUTIN_TABLE[BIG.includes(f) ? 'BIG' : (CUTIN_TABLE[f] ? f : 'other')];
  function pickCutin(f){
    let r = Math.random();
    for(const [k, p] of Object.entries(cutRow(f))){ if(r < p) return k; r -= p; }
    return null;
  }
  // 擬似連ステップアップ：何段目まで進むか（0＝なし）。⑤はメガポコナイト（激アツ）
  const GISI_TABLE = {
    BIG:  [.20, .15, .18, .17, .15, .15],
    WML:  [.40, .20, .15, .12, .09, .04],
    BEL:  [.40, .20, .15, .12, .09, .04],
    CHE:  [.62, .15, .11, .08, .03, .01],
    other:[.90, .07, .022, .006, .002, 0]
  };
  const gisiRow = f => GISI_TABLE[BIG.includes(f) ? 'BIG' : (GISI_TABLE[f] ? f : 'other')];
  function pickGisi(f){
    let r = Math.random();
    const row = gisiRow(f);
    for(let n=0;n<row.length;n++){ if(r < row[n]) return n; r -= row[n]; }
    return 0;
  }
  // 演出ごとの7・BAR期待度（今の設定の確率から計算）
  function expectOf(rateFn){
    let all = 0, big = 0, rest = 1;
    TABLE.forEach(([k,w]) => { const p = w/65536; rest -= p; const r = rateFn(k); all += p*r; if(BIG.includes(k)) big += p*r; });
    all += rest * rateFn(null);
    return all ? big/all : 0;
  }
  const GISI_START = 500, GISI_GAP = 1200, GISI_FREEZE = 420;
  const CUT_DUR = 1500;   // カットインの表示時間
  const GISI5_HOLD = 2000;  // ⑤追いメガポコナイトを液晶で見せる時間。その後に全画面の激アツ
  const GEKI_DUR = 7000;   // 全画面の激アツは7秒表示（タップで早送り可）
  const gekiRate = f => BIG.includes(f) ? GEKI_RATE.BIG : (GEKI_RATE[f] ?? GEKI_RATE.other);
  const calcGekiExpect = () => {
    let all = 0, big = 0, rest = 1;
    TABLE.forEach(([k,w]) => { const p = w/65536; rest -= p; all += p*gekiRate(k); if(BIG.includes(k)) big += p*gekiRate(k); });
    all += rest * gekiRate(null);
    return big / all;
  };

  // ================================================================
  // 6. サウンド（Web Audio APIで合成。音声ファイル不要）
  // ================================================================


  const audio = {
    ctx:null, fx:null, droneOsc:null, droneGain:null,
    // テンパイ中にじわじわ上がっていく持続音
    startDrone(){
      if(!state.sound || !this.ctx || this.droneOsc) return;
      const c = this.ctx, t = c.currentTime;
      const o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(440, t + 6);
      f.type = 'lowpass'; f.frequency.value = 1200;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(.05, t + .5);
      o.connect(f); f.connect(g); g.connect(this.fx); o.start(t);
      this.droneOsc = o; this.droneGain = g;
    },
    stopDrone(){
      if(!this.droneOsc) return;
      const t = this.ctx.currentTime;
      this.droneGain.gain.cancelScheduledValues(t);
      this.droneGain.gain.setValueAtTime(this.droneGain.gain.value, t);
      this.droneGain.gain.exponentialRampToValueAtTime(0.0001, t + .15);
      this.droneOsc.stop(t + .2); this.droneOsc = null;
    },
    init(){
      if(this.ctx) return;
      try{
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const master = ctx.createGain(); master.gain.value = .55; master.connect(ctx.destination);
        const delay = ctx.createDelay(); delay.delayTime.value = .13;
        const fb = ctx.createGain(); fb.gain.value = .28;
        const wet = ctx.createGain(); wet.gain.value = .25;
        delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);
        const bus = ctx.createGain(); bus.connect(master); bus.connect(delay);
        this.ctx = ctx; this.fx = bus; this.master = master;
        // 効果音の音源を読み込んでおく（assets/sound）
        const load = (url, key) => fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))
          .then(b => { this[key] = b; }).catch(() => {});
        load('assets/sound/ooi.mp3', 'ooiBuf');
        load('assets/sound/aishiteru.mp3', 'aiBuf');
      }catch(e){}
    },
    tone(freq, at=0, dur=.1, {type='square', vol=.08, to=null, vib=0}={}){
      if(!state.sound || !this.ctx) return;
      const c = this.ctx, t = c.currentTime + at;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if(to) o.frequency.exponentialRampToValueAtTime(to, t + dur*.7);
      if(vib){
        const l = c.createOscillator(), lg = c.createGain();
        l.frequency.value = 14; lg.gain.value = vib; l.connect(lg); lg.connect(o.frequency);
        l.start(t); l.stop(t + dur);
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + .008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.fx); o.start(t); o.stop(t + dur + .02);
    },
    noise(at=0, dur=.08, vol=.2, freq=900, type='lowpass'){
      if(!state.sound || !this.ctx) return;
      const c = this.ctx, t = c.currentTime + at;
      const buf = c.createBuffer(1, Math.ceil(c.sampleRate*dur), c.sampleRate);
      const d = buf.getChannelData(0); for(let i=0;i<d.length;i++) d[i] = Math.random()*2-1;
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      f.type = type; f.frequency.value = freq;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.buffer = buf; src.connect(f); f.connect(g); g.connect(this.fx); src.start(t);
    }
  };
  // ================================================================
  // 6-2. 通常ステージBGM：オルゴール風の行進曲（オリジナル曲。メロディ＋軽い低音）
  //      音符は [拍, 音名, 長さ(拍)]。4/4拍子・16小節でループ
  // ================================================================
  const MELODY = [
    // A
    'G4 .5','C5 .5','E5 1','D5 .5','C5 .5','A4 1',
    'F4 .5','A4 .5','C5 .5','D5 .5','E5 2',
    'E5 .5','F5 .5','G5 1','E5 .5','C5 .5','D5 1',
    'B4 .5','C5 .5','D5 .5','B4 .5','G4 2',
    'G4 .5','C5 .5','E5 1','G5 .5','E5 .5','C5 1',
    'A4 .5','C5 .5','F5 1','E5 .5','D5 .5','C5 1',
    'D5 .5','E5 .5','F5 .5','D5 .5','G5 .75','F5 .25','E5 .5','D5 .5',
    'C5 1','G4 1','C5 2',
    // B
    'A5 .5','G5 .5','E5 1','F5 .5','E5 .5','C5 1',
    'D5 .5','E5 .5','F5 .5','A5 .5','G5 2',
    'G5 .5','F5 .5','D5 1','E5 .5','D5 .5','B4 1',
    'C5 .5','D5 .5','E5 .5','G5 .5','A5 2',
    'A5 .5','G5 .5','E5 1','F5 .5','E5 .5','C5 1',
    'D5 .5','F5 .5','A5 1','G5 .5','F5 .5','E5 1',
    'D5 .5','E5 .5','F5 .5','A5 .5','G5 1','B4 1',
    'C5 1','E5 .5','D5 .5','C5 2'
  ];
  // 各小節の低音（1拍目＝根音、3拍目＝5度）
  const BASS = ['C','F','C','G','C','F','G','C','A','F','G','F','A','D','G','C'];
  const BASS_5TH = {C:'G',F:'C',G:'D',A:'E',D:'A'};
  const BPM = 132;
  const noteFreq = n => {
    const m = n.match(/([A-G])(#?)(\d)/), idx = {C:0,D:2,E:4,F:5,G:7,A:9,B:11}[m[1]] + (m[2] ? 1 : 0);
    return 440 * Math.pow(2, (idx + (+m[3] + 1)*12 - 69) / 12);
  };
  const BGM_EVENTS = (() => {
    const ev = []; let beat = 0;
    for(const s of MELODY){ const [n, d] = s.split(' '); ev.push({t:beat, f:noteFreq(n), v:1}); beat += +d; }
    BASS.forEach((r, bar) => { ev.push({t:bar*4, f:noteFreq(r + '3'), v:.45}); ev.push({t:bar*4 + 2, f:noteFreq(BASS_5TH[r] + '3'), v:.35}); });
    return ev.sort((a, b) => a.t - b.t);
  })();
  const LOOP_BEATS = 64;
  const bgm = {
    playing:false, timer:null, gain:null, ptr:0, loopStart:0,
    // オルゴールの音色：澄んだ正弦波＋高い倍音、すぐ立ち上がって長く減衰
    pluck(f, at, v){
      const c = audio.ctx;
      [[1, 1], [2, .28], [4.02, .08]].forEach(([mul, amp]) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f*mul;
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(.09*v*amp, at + .004);
        g.gain.exponentialRampToValueAtTime(0.0001, at + (mul === 1 ? 1.5 : .5));
        o.connect(g); g.connect(this.gain); o.start(at); o.stop(at + 1.6);
      });
    },
    schedule(){
      const c = audio.ctx, spb = 60 / BPM;
      while(true){
        const ev = BGM_EVENTS[this.ptr], at = this.loopStart + ev.t*spb;
        if(at > c.currentTime + .3) break;
        if(at >= c.currentTime - .02) this.pluck(ev.f, Math.max(at, c.currentTime), ev.v);
        if(++this.ptr >= BGM_EVENTS.length){ this.ptr = 0; this.loopStart += LOOP_BEATS*spb; }
      }
    },
    start(){
      if(this.playing || !audio.ctx) return;
      const c = audio.ctx;
      this.gain = c.createGain(); this.gain.gain.value = .0001; this.gain.connect(audio.fx);
      this.gain.gain.exponentialRampToValueAtTime(1, c.currentTime + .6);
      this.playing = true; this.ptr = 0; this.loopStart = c.currentTime + .1;
      this.timer = setInterval(() => this.schedule(), 60);
    },
    stop(){
      if(!this.playing) return;
      this.playing = false; clearInterval(this.timer);
      const g = this.gain, t = audio.ctx.currentTime;
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.exponentialRampToValueAtTime(.0001, t + .25);
      setTimeout(() => g.disconnect(), 800);
    },
    // 今の拍の位置（キャラをリズムに合わせて揺らす用）
    beat(){ return this.playing ? (audio.ctx.currentTime - this.loopStart) * BPM / 60 : performance.now()/1000 * BPM / 60; }
  };

  const sfx = {
    coin(){ audio.tone(1976,0,.08,{type:'sine',vol:.12}); audio.tone(2637,.05,.18,{type:'sine',vol:.1}); },
    lever(){ audio.noise(0,.09,.35,700); audio.tone(95,0,.12,{type:'sine',vol:.25,to:60}); },
    tick(){ audio.tone(1800,0,.012,{type:'square',vol:.012}); },
    stop(i){ audio.noise(0,.06,.3,1400); audio.tone(180 - i*20,0,.08,{type:'square',vol:.07,to:90}); },
    // ランプ点灯の「ガコッ」：短い打撃ノイズ＋低い胴鳴り＋小さな跳ね返り
    gako(){
      audio.noise(0,.05,.6,1100);
      audio.tone(150,0,.11,{type:'square',vol:.16,to:55});
      audio.tone(90,0,.14,{type:'sine',vol:.3,to:45});
      audio.noise(.045,.05,.28,450);
    },
    cutin(type){
      audio.noise(0,.25,.35,4000,'highpass');
      const base = {green:523, red:659, rainbow:784}[type];
      [1, 1.26, 1.5, 2].forEach((m,k) => audio.tone(base*m, .08 + k*.06, .35, {type:'square', vol:.07}));
      if(type === 'rainbow') [0,.1,.2,.3,.4].forEach(a => audio.tone(2637, .5 + a, .12, {type:'sine', vol:.07}));
    },
    // 全画面の激アツ：「愛してる」の音源を再生
    aishiteru(){
      if(!state.sound || !audio.ctx || !audio.aiBuf) return;
      const src = audio.ctx.createBufferSource(), g = audio.ctx.createGain();
      src.buffer = audio.aiBuf; g.gain.value = 1.1;
      src.connect(g); g.connect(audio.master); src.start();
    },
    // おじいちゃんの「おーい」：添付の音源を再生
    ooi(){
      if(!state.sound || !audio.ctx || !audio.ooiBuf) return;
      const src = audio.ctx.createBufferSource(), g = audio.ctx.createGain();
      src.buffer = audio.ooiBuf; g.gain.value = 1.1;
      src.connect(g); g.connect(audio.master); src.start();
    },
    gisi(k){
      audio.noise(0,.12,.5,700); audio.tone(110,0,.18,{type:'square',vol:.18,to:55});
      audio.tone(440*Math.pow(1.19,k),.12,.3,{type:'triangle',vol:.1}); audio.tone(660*Math.pow(1.19,k),.2,.35,{type:'triangle',vol:.08});
    },
    atStart(){ [523,659,784,1047,784,1047,1319,1568].forEach((f,k)=>audio.tone(f,k*.09,.18,{type:'square',vol:.07})); },
    atEnd(){ [784,988,1175,1568].forEach((f,k)=>audio.tone(f,k*.12,.3,{type:'triangle',vol:.1})); },
    navi(){ audio.tone(1568,0,.08,{type:'square',vol:.05}); audio.tone(1568,.12,.08,{type:'square',vol:.05}); },
    // ハート連打：ポコポコと弾む音
    meteor(gold){ for(let k=0;k<(gold?10:6);k++) audio.tone((gold?1400:1000)+k*90,k*.07,.07,{type:'sine',vol:gold?.09:.07,to:(gold?2200:1600)+k*90}); },
    // 激アツ：衝撃音＋サイレン＋歓声
    gekiatsu(){
      audio.noise(0,.6,.7,260); audio.tone(130,0,.7,{type:'sawtooth',vol:.22,to:38});
      audio.tone(620,.18,1.9,{type:'square',vol:.045,vib:140});
      audio.noise(.25,1.9,.16,1400,'bandpass');
      [523,659,784,1047].forEach((f,k)=>audio.tone(f,.3+k*.05,.9,{type:'triangle',vol:.05}));
    },
    chestDrop(){ audio.noise(0,.12,.35,400); audio.tone(110,0,.15,{type:'sine',vol:.2,to:70}); },
    rattle(power){ for(let k=0;k<4+power*3;k++) audio.noise(k*.05,.03,.12+power*.05,2500,'bandpass'); },
    chestOpen(good){
      if(good) [784,988,1175,1568].forEach((f,k)=>audio.tone(f,k*.06,.2,{type:'triangle',vol:.12}));
      else audio.noise(0,.35,.12,600);
    },
    starPing(n){ audio.tone(1047*Math.pow(1.122,n),0,.3,{type:'sine',vol:.08}); },
    hokutoWin(){ [1047,1319,1568,2093].forEach(f=>audio.tone(f,0,1.2,{type:'triangle',vol:.06})); },
    hokutoFail(){ audio.tone(523,0,.3,{type:'triangle',vol:.07,to:330}); },
    smallWin(){ [880,1109,1319,1760].forEach((f,k)=>audio.tone(f,k*.06,.14,{type:'triangle',vol:.12})); },
    replay(){ audio.tone(988,0,.1,{type:'triangle',vol:.12}); audio.tone(1319,.08,.16,{type:'triangle',vol:.12}); },
    midWin(){
      [523,659,784,1047,1319,1568,2093].forEach((f,k)=>audio.tone(f,k*.07,.2,{type:'triangle',vol:.13}));
      [0,.1,.2,.3].forEach(a=>audio.tone(2637,.55+a,.1,{type:'sine',vol:.06}));
    },
    jackpot(){
      const n = [[523,.0,.15],[523,.15,.15],[523,.3,.15],[659,.45,.45],[784,.95,.15],[659,1.1,.15],[784,1.25,.8]];
      n.forEach(([f,a,d])=>{ audio.tone(f,a,d,{type:'square',vol:.09}); audio.tone(f*2,a,d,{type:'triangle',vol:.06}); audio.tone(f/2,a,d,{type:'sawtooth',vol:.04}); });
      [1047,1319,1568,2093].forEach(f=>audio.tone(f,1.25,.9,{type:'triangle',vol:.05}));
    },
    firework(){ audio.noise(0,.4,.15,1800); },
    heart(){ audio.tone(70,0,.16,{type:'sine',vol:.35,to:45}); audio.tone(62,.2,.14,{type:'sine',vol:.25,to:40}); },
    tenpai(){ [392,523,784].forEach((f,k)=>audio.tone(f,k*.09,.25,{type:'square',vol:.07})); audio.noise(0,.25,.2,3000,'highpass'); },
    tenpaiFail(){ audio.noise(0,.2,.25,500); audio.tone(330,0,.5,{type:'sawtooth',vol:.08,to:100}); },
    bell(){ audio.tone(2093,0,.05,{type:'sine',vol:.05}); audio.tone(2637,.04,.05,{type:'sine',vol:.05}); },
    payTick(k){ audio.tone(k%2 ? 2200 : 2600,0,.03,{type:'square',vol:.02}); },
    miss(){ audio.tone(220,0,.18,{type:'sawtooth',vol:.08,to:140}); }
  };

  // ================================================================
  // 7. 画面の準備
  // ================================================================
  const $ = id => document.getElementById(id);
  const stripEls = [...document.querySelectorAll('.strip')];
  const stopBtns = [...document.querySelectorAll('.stop')];
  const lever = $('lever'), msgEl = $('msg'), linesSvg = $('lines');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const store = {
    get(k,d){ try{ const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); }catch(e){ return d; } },
    set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
  };
  const saved = store.get('slot4.state', null);
  const state = {
    credits: saved ? saved.credits : 100,
    games: saved ? saved.games : 0,
    coinIn: saved ? saved.coinIn : 0,
    coinOut: saved ? saved.coinOut : 0,
    carry: saved ? saved.carry : null,
    at: saved ? saved.at || null : null, navi: null, ctrlFlag: null,
    payout: 0, replay: false, flag: null, ready: false, scene: null, tenpai: false, geki: false,
    cutin: null, gisi: 0, gisiDone: 0, gisiDelay: 0, lockUntil: 0, skipQueued: false, ooi: false,
    peka: saved ? !!saved.carry : false, postPeka: false, pekaType: '-',
    phase: 'idle', startTs: 0, lastTs: 0,
    sound: store.get('slot.sound', true),
    bgm: store.get('slot.bgm', true),
    setting: store.get('slot.setting', 3)
  };
  applySetting(state.setting); calcExpect();
  const save = () => store.set('slot4.state', {credits:state.credits, games:state.games,
    coinIn:state.coinIn, coinOut:state.coinOut, carry:state.carry, at:state.at});

  const reels = STRIPS.map((strip, i) => {
    const el = stripEls[i];
    el.innerHTML = strip.concat(strip.slice(0,3)).map(s => `<div class="sym">${SYM[s].html}</div>`).join('');
    return {el, p: Math.floor(Math.random()*N), spinning:false, stopping:false, remain:0, stopPos:null, slide:null, lastTick:0};
  });

  let cell = 64;
  const render = r => { r.el.style.transform = `translateY(${-r.p*cell}px)`; };
  const measure = () => {
    cell = stripEls[0].children[0].getBoundingClientRect().height || cell;
    reels.forEach(render); layoutBulbs(); resizeFx(); screen.resize();
  };

  function layoutBulbs(){
    const box = $('topper').getBoundingClientRect(), wrap = $('bulbs');
    const w = box.width, h = box.height, inset = 10, gap = 22;
    const W = w - 2*inset, H = h - 2*inset, per = 2*(W + H), n = Math.floor(per / gap);
    let html = '';
    for(let k=0;k<n;k++){
      let d = k * per / n, x, y;
      if(d < W){ x = inset + d; y = inset; }
      else if((d -= W) < H){ x = w - inset; y = inset + d; }
      else if((d -= H) < W){ x = w - inset - d; y = h - inset; }
      else { d -= W; x = inset; y = h - inset - d; }
      html += `<i class="bulb" style="left:${x}px;top:${y}px"></i>`;
    }
    wrap.innerHTML = html;
  }

  $('paytable').innerHTML = [
    ['7 ×3', 'AT 300枚'], ['BAR ×3', 'AT 100枚'], ['ベル ×3', '14枚'], ['スイカ ×3', '10枚'],
    ['ぶどう ×3', '8枚'], ['チェリー（左リール）', '2枚'], ['リプレイ ×3', '再遊技']
  ].map(([a,b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');

  // ================================================================
  // 8. 配信者キャラ「かぴすけ」（ゆるいカピバラ。頭にみかん、ピンクのヘッドホン）
  //    液晶と全画面演出の両方で使うので、描画先(ctx)を引数で受け取る
  // ================================================================
  function rrPath(c, x, y, w, h, r){
    c.beginPath(); c.moveTo(x+r, y); c.arcTo(x+w, y, x+w, y+h, r); c.arcTo(x+w, y+h, x, y+h, r);
    c.arcTo(x, y+h, x, y, r); c.arcTo(x, y, x+w, y, r); c.closePath();
  }
  // 太字・斜体の「7」（金縁＋赤グラデーション）
  function draw7(c, x, y, size){
    c.save(); c.translate(x, y); c.transform(1, 0, -.16, 1, 0, 0);
    c.font = `${size}px "Titan One", Impact, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    c.lineWidth = size*.2; c.strokeStyle = '#3d000c'; c.strokeText('7', 0, 0);
    c.lineWidth = size*.12; c.strokeStyle = '#F7C948'; c.strokeText('7', 0, 0);
    c.lineWidth = size*.04; c.strokeStyle = '#3d000c'; c.strokeText('7', 0, 0);
    const gr = c.createLinearGradient(0, -size/2, 0, size/2);
    gr.addColorStop(0, '#ff8a8a'); gr.addColorStop(.42, '#ee1c34'); gr.addColorStop(.6, '#b3001f'); gr.addColorStop(1, '#ff4b5c');
    c.shadowBlur = 0; c.fillStyle = gr; c.fillText('7', 0, 0);
    c.restore();
  }
  function heartPath(c, x, y, s){
    c.beginPath(); c.moveTo(x, y + s*.35);
    c.bezierCurveTo(x - s*1.1, y - s*.4, x - s*.45, y - s*1.05, x, y - s*.45);
    c.bezierCurveTo(x + s*.45, y - s*1.05, x + s*1.1, y - s*.4, x, y + s*.35);
    c.closePath();
  }
  function drawCapy(c, x, y, s, mood, t){
    c.save(); c.translate(x, y); c.scale(s, s);
    const br = Math.sin(t/600);
    // 体
    c.fillStyle = '#A8764A'; c.beginPath(); c.ellipse(0, 30, 40, 22 + br*.6, 0, 0, 6.283); c.fill();
    c.translate(0, br*.8);
    // 耳
    c.fillStyle = '#8A5A34';
    c.beginPath(); c.ellipse(-22, -27, 6, 4.5, -.3, 0, 6.283); c.ellipse(22, -27, 6, 4.5, .3, 0, 6.283); c.fill();
    // 頭
    c.fillStyle = '#B98552'; rrPath(c, -32, -28, 64, 52, 22); c.fill();
    // ヘッドホン
    c.strokeStyle = '#3a3a48'; c.lineWidth = 4;
    c.beginPath(); c.arc(0, -4, 36, Math.PI*1.1, Math.PI*1.9); c.stroke();
    c.fillStyle = '#FF7FB0'; rrPath(c, -41, -12, 11, 22, 4); c.fill(); rrPath(c, 30, -12, 11, 22, 4); c.fill();
    // 頭の上のみかん
    const hop = mood === 'shock' ? -4 : 0;
    c.fillStyle = '#FF9A2E'; c.beginPath(); c.arc(0, -34 + hop, 7.5, 0, 6.283); c.fill();
    c.fillStyle = '#FFC27A'; c.beginPath(); c.arc(-2.5, -36 + hop, 2, 0, 6.283); c.fill();
    c.fillStyle = '#4CAF50'; c.beginPath(); c.ellipse(3, -41.5 + hop, 4, 2, -.5, 0, 6.283); c.fill();
    // ほっぺ
    c.fillStyle = 'rgba(255,120,150,.55)';
    c.beginPath(); c.ellipse(-21, 7, 5, 3, 0, 0, 6.283); c.ellipse(21, 7, 5, 3, 0, 0, 6.283); c.fill();
    // 鼻先
    c.fillStyle = '#D4A373'; c.beginPath(); c.ellipse(0, 9, 17, 11, 0, 0, 6.283); c.fill();
    c.fillStyle = '#5a3a22'; c.beginPath(); c.ellipse(-5, 5, 2.2, 1.5, 0, 0, 6.283); c.ellipse(5, 5, 2.2, 1.5, 0, 0, 6.283); c.fill();
    // 目
    c.fillStyle = '#2a1a10'; c.strokeStyle = '#2a1a10'; c.lineWidth = 2; c.lineCap = 'round';
    const blink = (t % 3400) < 130;
    if(mood === 'happy' || mood === 'jump'){
      c.beginPath(); c.arc(-12, -5, 4, Math.PI*1.15, Math.PI*1.85); c.moveTo(16, -7.5); c.arc(12, -5, 4, Math.PI*1.15, Math.PI*1.85); c.stroke();
    } else if(mood === 'shock'){
      c.fillStyle = '#fff'; c.beginPath(); c.arc(-12, -6, 6, 0, 6.283); c.arc(12, -6, 6, 0, 6.283); c.fill();
      c.fillStyle = '#2a1a10'; c.beginPath(); c.arc(-12, -6, 2.8, 0, 6.283); c.arc(12, -6, 2.8, 0, 6.283); c.fill();
      c.fillStyle = '#7fd3ff'; c.beginPath(); c.moveTo(30, -20); c.quadraticCurveTo(35, -12, 30, -9); c.quadraticCurveTo(25, -12, 30, -20); c.fill();
    } else if(mood === 'sad'){
      c.beginPath(); c.moveTo(-16, -7); c.lineTo(-8, -4); c.moveTo(16, -7); c.lineTo(8, -4); c.stroke();
      c.fillStyle = '#7fd3ff'; c.beginPath(); c.ellipse(-12, 1 + (t/40 % 8), 1.6, 2.6, 0, 0, 6.283); c.fill();
    } else if(blink){
      c.beginPath(); c.moveTo(-15, -5); c.lineTo(-9, -5); c.moveTo(9, -5); c.lineTo(15, -5); c.stroke();
    } else {
      const ey = mood === 'look' ? -9 : -5;
      c.beginPath(); c.arc(-12, ey, 2.4, 0, 6.283); c.arc(12, ey, 2.4, 0, 6.283); c.fill();
    }
    // 口
    c.strokeStyle = '#5a3a22'; c.lineWidth = 1.4;
    if(mood === 'talk'){
      const o = 1 + Math.abs(Math.sin(t/90))*3;
      c.fillStyle = '#7a3a2a'; c.beginPath(); c.ellipse(0, 15, 3.5, o, 0, 0, 6.283); c.fill();
    } else if(mood === 'shock'){
      c.fillStyle = '#7a3a2a'; c.beginPath(); c.ellipse(0, 16, 4, 5, 0, 0, 6.283); c.fill();
    } else if(mood === 'happy' || mood === 'jump'){
      c.fillStyle = '#7a3a2a'; c.beginPath(); c.arc(0, 13, 5, 0, Math.PI); c.fill();
    } else {
      c.beginPath(); c.moveTo(-4, 13); c.quadraticCurveTo(-2, 15.5, 0, 13); c.quadraticCurveTo(2, 15.5, 4, 13); c.stroke();
    }
    c.restore();
  }

  // ================================================================
  // 8-2. 液晶パネル（ライブ配信画面。論理サイズ320×160）
  // ================================================================
  const VIEWERS = [['🐰','もも'],['🐻','くま吉'],['🐱','みけ'],['🐶','ぽち'],['🐼','ぱんだ'],['🦊','こん'],['🐹','はむ'],['🐧','ぺん'],['🐨','こあら'],['🐸','けろ']];
  const TALK = {
    calm: ['こんばんは〜','かぴすけかわいい','のんびり配信すき','今日も来たよ','みかん乗ってるw','何ゲーム目？','ぶどう来て','まったり〜','おつかれさま','7見たい'],
    hype: ['おおお','きたか!?','アツい','ギフトきた！','これは…','こいこい','やばい','期待！'],
    win:  ['おめでとう！','8888','すごい！','きたー！','ナイス！'],
    lose: ['どんまい','おしい…','次いこ','ドンマイ！'],
    reach:['7こい!!','こいこいこい','止めろ！','いけえええ','7!!7!!']
  };
  const pick = a => a[Math.floor(Math.random()*a.length)];

  // 通常ステージのキャラクター（添付画像。背景を透過して埋め込み）
  const HERO = new Image();
  HERO.src = 'assets/img/haishin.webp';

  // ボーナス（AT）中のキャラクター（2枚目の添付画像）
  const HEROINE = new Image();
  HEROINE.src = 'assets/img/bonus.webp';

  // 擬似連で登場するおじいちゃん（添付画像）
  const OJII = new Image();
  OJII.src = 'assets/img/ojii.webp';
  // 激アツ全画面演出のキャラクター
  const TUX = new Image();
  TUX.src = 'assets/img/gekiatsu.webp';

  const screen = (() => {
    const cv = $('screen'), g = cv.getContext('2d');
    const W = 320, H = 160, DESK = 130;
    let scale = 1;
    const rnd = (a,b) => a + Math.random()*(b-a);
    const sky = Array.from({length:40}, () => ({x:rnd(0,W), y:rnd(0,H), r:rnd(.4,1.3), ph:rnd(0,6.28)}));
    const RANKS = [50, 28, 12, 3];

    const S = {mode:'idle', scene:'walk', t0:0, stage:0, result:null, resT:0, fireworks:[],
      nextFw:0, jumpT:-1e9, bigKey:null, tenpai:false, tenpaiT:0, at:null, navi:null, gain:0, gainT:-1e9,
      endInfo:null, comments:[], nextCom:0, hearts:[], nextHeart:0, viewers:1234, likes:12800,
      burst:false, shockT:-1e9, nico:[], rankNow:50, talkT:0, gifter:VIEWERS[1],
      aim:null, cut:null, cutT:-1e9, gisi:0, gisiT:-1e9, gisiFx:[], ooiT:-1e9};

    function resize(){
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth || 320;
      cv.width = Math.round(w * dpr); cv.height = Math.round(w / 2 * dpr);
      scale = cv.width / W;
    }

    // --- コメント・ハート ---
    function comment(text, who = pick(VIEWERS)){
      S.comments.push({av:who[0], name:who[1], text, born:performance.now()});
      if(S.comments.length > 4) S.comments.shift();
    }
    function hearts(n, gold=false){
      for(let k=0;k<n;k++) S.hearts.push({x:rnd(262,306), y:rnd(118,150), vx:rnd(-.4,.2), vy:rnd(-1.6,-.8)*(gold?1.3:1),
        s:rnd(4,7)*(gold?1.3:1), life:1, gold, hue:pick([340,350,0,320])});
      S.likes += n * (gold ? 30 : 3);
    }

    // --- 部屋の背景 ---
    function drawRoom(t){
      const wall = g.createLinearGradient(0,0,0,H);
      wall.addColorStop(0,'#FFE6D6'); wall.addColorStop(1,'#FFC7C7');
      g.fillStyle = wall; g.fillRect(0,0,W,H);
      g.fillStyle = 'rgba(255,255,255,.45)';
      for(let y=10;y<DESK;y+=16) for(let x=(y/16%2)*8;x<W;x+=16){ g.beginPath(); g.arc(x,y,1.6,0,6.283); g.fill(); }
      // 窓（夜空）
      g.fillStyle = '#fff'; rrPath(g, 14, 30, 62, 56, 6); g.fill();
      const ns = g.createLinearGradient(0,34,0,82); ns.addColorStop(0,'#1b1850'); ns.addColorStop(1,'#4a2a7a');
      g.fillStyle = ns; rrPath(g, 18, 34, 54, 48, 4); g.fill();
      g.fillStyle = '#FFF3B0'; g.beginPath(); g.arc(58, 46, 6, 0, 6.283); g.fill();
      g.fillStyle = '#1b1850'; g.beginPath(); g.arc(61, 44, 5, 0, 6.283); g.fill();
      for(let k=0;k<6;k++){ g.globalAlpha = .4 + .6*Math.abs(Math.sin(t/500+k)); g.fillStyle='#fff'; g.fillRect(22+k*8, 40+(k*13%30), 1.2, 1.2); }
      g.globalAlpha = 1;
      g.fillStyle = '#fff'; g.fillRect(44, 34, 2, 48); g.fillRect(18, 57, 54, 2);
      // 観葉植物
      g.fillStyle = '#E07A5F'; rrPath(g, 276, 104, 26, 26, 4); g.fill();
      g.fillStyle = '#5DB075';
      [[-8,-10,.6],[0,-16,0],[8,-10,-.6],[-4,-4,.9],[5,-5,-.9]].forEach(([dx,dy,a]) => { g.beginPath(); g.ellipse(289+dx, 100+dy, 5, 11, a, 0, 6.283); g.fill(); });
      // リングライト
      g.save(); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 5; g.shadowColor = '#fff'; g.shadowBlur = 14;
      g.beginPath(); g.arc(160, 84, 50, 0, 6.283); g.stroke(); g.restore();
    }
    function drawFloor(){
      g.fillStyle = '#8B5E3C'; g.fillRect(0, DESK, W, H - DESK);
      g.fillStyle = '#A8764A'; g.fillRect(0, DESK, W, 3);
      g.fillStyle = 'rgba(255,255,255,.08)'; for(let x=0;x<W;x+=26) g.fillRect(x, DESK + 3, 1, H);
      // ラグ
      g.fillStyle = '#E86A92'; g.beginPath(); g.ellipse(160, 150, 92, 12, 0, 0, 6.283); g.fill();
      g.fillStyle = '#F59AB6'; g.beginPath(); g.ellipse(160, 150, 78, 8, 0, 0, 6.283); g.fill();
    }
    function drawMic(){
      g.fillStyle = '#444'; g.fillRect(236, 84, 3, 64); g.fillRect(226, 146, 23, 3);
      g.fillStyle = '#6a6a78'; rrPath(g, 230, 66, 15, 22, 7); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 1;
      for(let y=70;y<86;y+=3){ g.beginPath(); g.moveTo(232,y); g.lineTo(243,y); g.stroke(); }
    }
    function drawDesk(){ drawFloor(); drawMic(); }

    // 添付キャラの動き：BGMの拍に合わせて体を揺らし、状況に応じて跳ねる・震える・うなだれる
    const notes = [];
    function drawHero(t, mood){
      const HH = 118, HW = HH * (HERO.naturalWidth || 412) / (HERO.naturalHeight || 440);
      const beat = bgm.beat(), ph = beat % 1;
      let x = 160, y = 152, rot = 0, sx = 1, sy = 1, alpha = 1;
      if(mood === 'idle' || mood === 'talk'){
        rot = Math.sin(beat * Math.PI) * .06;                 // 2拍で左右に揺れる
        sy = 1 - Math.exp(-ph * 7) * .035; sx = 1 + Math.exp(-ph * 7) * .02; // 拍の頭で少し沈む
        if(mood === 'talk') y -= Math.abs(Math.sin(t/110)) * 2;
      } else if(mood === 'look'){
        rot = -.1 + Math.sin(t/300) * .02; y -= 3;
      } else if(mood === 'happy' || mood === 'jump'){
        y -= Math.abs(Math.sin(t/140)) * 14; rot = Math.sin(t/140) * .1;
      } else if(mood === 'sad'){
        rot = .08; sy = .94; y += 4; alpha = .85;
      } else if(mood === 'shock'){
        x += (Math.random() - .5) * 5; y -= 6; sx = sy = 1.07;
      }
      g.save(); g.globalAlpha = alpha;
      g.translate(x, y); g.rotate(rot); g.scale(sx, sy);
      if(HERO.complete && HERO.naturalWidth) g.drawImage(HERO, -HW/2, -HH, HW, HH);
      g.restore();
      // 状況ごとの記号
      g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
      if(mood === 'shock'){ g.font = 'bold 26px "M PLUS 1p", sans-serif'; g.fillStyle = '#FF2D55'; g.strokeStyle = '#fff'; g.lineWidth = 4;
        g.strokeText('!!', x + 58, 44); g.fillText('!!', x + 58, 44); }
      if(mood === 'sad'){ g.font = '18px sans-serif'; g.fillText('💦', x + 50, 58 + Math.sin(t/200)*2); }
      if(mood === 'happy' || mood === 'jump'){ for(let k=0;k<3;k++){ const a = t/300 + k*2.1;
        g.font = '12px sans-serif'; g.fillText('✨', x + Math.cos(a)*62, 80 + Math.sin(a)*34); } }
      g.restore();
      // BGM中は音符がふわふわ出る
      if(bgm.playing && (mood === 'idle' || mood === 'talk') && Math.random() < .02)
        notes.push({x:x + (Math.random() < .5 ? -52 : 52), y:70, life:1, ch:Math.random() < .5 ? '♪' : '♫'});
      for(let k = notes.length - 1; k >= 0; k--){
        const n = notes[k]; n.y -= .35; n.x += Math.sin(n.y/8)*.3; n.life -= .01;
        if(n.life <= 0){ notes.splice(k, 1); continue; }
        g.save(); g.globalAlpha = n.life; g.fillStyle = '#E8457A'; g.font = 'bold 13px sans-serif'; g.fillText(n.ch, n.x, n.y); g.restore();
      }
    }

    // --- 配信UI（LIVEバッジ・視聴者数・コメント・ハート）---
    function drawUI(t){
      g.save();
      g.fillStyle = '#FF2D55'; rrPath(g, 6, 6, 30, 13, 4); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 8.5px sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center';
      g.fillText('LIVE', 21, 13);
      g.fillStyle = 'rgba(0,0,0,.45)'; rrPath(g, 40, 6, 52, 13, 4); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = '8.5px sans-serif';
      g.fillText('👁 ' + Math.floor(S.viewers).toLocaleString(), 44, 13);
      g.fillStyle = 'rgba(0,0,0,.45)'; rrPath(g, W - 64, 6, 58, 13, 4); g.fill();
      g.fillStyle = '#fff'; g.fillText('❤ ' + (S.likes >= 10000 ? (S.likes/10000).toFixed(1) + '万' : S.likes), W - 58, 13);
      // コメント欄（左下）
      const now = performance.now();
      S.comments.forEach((m, i) => {
        const y = H - 12 - (S.comments.length - 1 - i) * 13;
        const age = Math.min(1, (now - m.born)/200);
        const txt = `${m.name}  ${m.text}`;
        g.font = '8px "M PLUS 1p", sans-serif';
        const w = g.measureText(txt).width + 20;
        g.globalAlpha = age;
        g.fillStyle = 'rgba(0,0,0,.42)'; rrPath(g, 6 - (1-age)*10, y - 6, w, 12, 6); g.fill();
        g.fillStyle = '#fff'; g.font = '8px sans-serif'; g.fillText(m.av, 9 - (1-age)*10, y);
        g.font = 'bold 8px "M PLUS 1p", sans-serif'; g.fillStyle = '#FFD1E3'; g.fillText(m.name, 20 - (1-age)*10, y);
        const nw = g.measureText(m.name).width;
        g.font = '8px "M PLUS 1p", sans-serif'; g.fillStyle = '#fff'; g.fillText(m.text, 24 + nw - (1-age)*10, y);
      });
      g.globalAlpha = 1;
      // ハート
      S.hearts = S.hearts.filter(h => h.life > 0);
      for(const h of S.hearts){
        h.x += h.vx + Math.sin((h.y + h.s)*.15)*.3; h.y += h.vy; h.life -= .012;
        g.globalAlpha = Math.max(0, h.life);
        g.fillStyle = h.gold ? '#FFD23A' : `hsl(${h.hue},90%,65%)`;
        if(h.gold){ g.shadowColor = '#FFB000'; g.shadowBlur = 8; }
        heartPath(g, h.x, h.y, h.s); g.fill(); g.shadowBlur = 0;
      }
      g.globalAlpha = 1;
      g.restore();
    }

    function drawSymbol(key, x, y, size){
      g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
      if(key === 'S7'){
        draw7(g, x, y, size);
      } else if(key === 'BAR'){
        g.fillStyle = '#161616'; g.fillRect(x - size*.6, y - size*.28, size*1.2, size*.56);
        g.strokeStyle = '#F2C14E'; g.lineWidth = 2; g.strokeRect(x - size*.6, y - size*.28, size*1.2, size*.56);
        g.fillStyle = '#F2C14E'; g.font = `bold ${size*.36}px sans-serif`; g.fillText('BAR', x, y + 1);
      } else if(key === 'RPL'){
        g.fillStyle = '#1A5FB4'; g.font = `bold ${size*.32}px sans-serif`; g.fillText('REPLAY', x, y);
      } else if(key){
        g.font = `${size*.8}px sans-serif`; g.fillText({WML:'🍉', CHE:'🍒', BEL:'🔔', GRP:'🍇'}[key], x, y);
      }
      g.restore();
    }

    // --- 予告：ギフト箱 ---
    const GIFT = {chestBlue:'#4C8DFF', chestGreen:'#2FBF71', chestRed:'#FF3B5C'};
    function drawGift(t, openAmt){
      const since = t - S.t0, fall = Math.min(1, since/450);
      const bounce = fall < 1 ? 0 : Math.max(0, Math.sin((since-450)/60)*5*Math.exp(-(since-450)/150));
      let x = 278, y = -30 + (DESK - 14 + 30)*(1 - Math.pow(1-fall, 3)) - bounce;
      const power = openAmt > 0 ? 0 : S.stage;
      if(power) x += Math.sin(t/(power > 1 ? 25 : 45)) * power * 1.5;
      const color = S.scene === 'chestRainbow' ? `hsl(${(t/4)%360},90%,58%)` : GIFT[S.scene];
      g.save();
      if(openAmt > 0 && S.result && S.result.flag){
        g.save(); g.translate(x, y - 16); g.rotate(t/900);
        for(let k=0;k<12;k++){ g.rotate(Math.PI/6); g.fillStyle = k%2 ? 'rgba(255,240,160,.45)' : 'rgba(255,200,80,.22)';
          g.beginPath(); g.moveTo(0,0); g.lineTo(70,-9); g.lineTo(70,9); g.fill(); }
        g.restore();
      }
      if(power >= 2 || openAmt > 0){ g.shadowColor = color; g.shadowBlur = 16; }
      g.fillStyle = color; rrPath(g, x-17, y-12, 34, 26, 3); g.fill(); g.shadowBlur = 0;
      g.fillStyle = '#FFE38A'; g.fillRect(x-3, y-12, 6, 26);
      g.save(); g.translate(x-19, y-12); g.rotate(-openAmt*1.2);
      g.fillStyle = color; rrPath(g, 0, -7, 38, 8, 2); g.fill(); g.fillStyle = '#FFE38A'; g.fillRect(16, -7, 6, 8);
      g.beginPath(); g.ellipse(14, -10, 6, 4, -.5, 0, 6.283); g.ellipse(24, -10, 6, 4, .5, 0, 6.283); g.fill();
      g.restore(); g.restore();
      // 送り主の吹き出し
      if(since < 2200 && openAmt === 0){
        g.save(); g.globalAlpha = Math.min(1, since/200);
        g.fillStyle = 'rgba(0,0,0,.55)'; rrPath(g, 180, 24, 134, 16, 8); g.fill();
        g.fillStyle = '#fff'; g.font = 'bold 8.5px "M PLUS 1p", sans-serif'; g.textBaseline = 'middle';
        g.fillText(`${S.gifter[0]} ${S.gifter[1]}さんからギフト！`, 188, 32); g.restore();
      }
      if(openAmt > 0){
        const rise = Math.min(1, (t - S.resT)/500);
        if(S.result && S.result.flag) drawSymbol(S.result.flag, x, y - 18 - rise*22, 26);
        else {
          g.fillStyle = `rgba(190,190,200,${.6*(1-rise*.6)})`;
          [[-7,0],[4,-5],[9,4]].forEach(([dx,dy]) => { g.beginPath(); g.arc(x+dx, y-16-rise*16+dy, 7+rise*4, 0, 6.283); g.fill(); });
        }
      }
    }

    // --- 予告：ランキング急上昇 ---
    function drawRank(t){
      const res = S.mode === 'result' ? S.result : null;
      const success = res && BIG.includes(res.flag);
      const target = success ? 1 : RANKS[Math.min(S.stage, 3)];
      S.rankNow += (target - S.rankNow) * .12;
      const shown = Math.max(1, Math.round(S.rankNow));
      g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = success ? 'rgba(255,200,40,.92)' : 'rgba(40,20,70,.85)';
      if(success){ g.shadowColor = '#FFD23A'; g.shadowBlur = 16; }
      rrPath(g, 104, 24, 112, 40, 8); g.fill(); g.shadowBlur = 0;
      g.fillStyle = success ? '#6a2a00' : '#FFD1E3'; g.font = 'bold 8px "M PLUS 1p", sans-serif';
      g.fillText('デイリーランキング', 160, 32);
      g.fillStyle = success ? '#fff' : '#fff'; g.font = `bold ${success ? 22 : 19}px "M PLUS 1p", sans-serif`;
      g.fillText(`${shown}位${success ? '!!' : ''}`, 160, 50);
      if(!res){ const a = Math.sin(t/120)*2; g.fillStyle = '#5DFFB0';
        g.beginPath(); g.moveTo(204, 50 + a); g.lineTo(210, 42 + a); g.lineTo(216, 50 + a); g.fill(); g.fillRect(208, 50 + a, 4, 6); }
      g.restore();
    }

    // --- 7テンパイ：配信画面がコメントで埋まる ---
    function drawTenpai(t){
      const e = t - S.tenpaiT;
      g.fillStyle = 'rgba(40,0,10,.86)'; g.fillRect(0,0,W,H);
      g.save(); g.translate(W/2, H/2 - 6);
      for(let k=0;k<40;k++){
        const a = k/40*6.283 + (k%2 ? t/2000 : -t/2600), r0 = 34 + (k*37 % 20);
        g.strokeStyle = `rgba(255,${120 + (k%3)*50},120,${.22 + (k%4)*.07})`; g.lineWidth = k%3 ? 1 : 2;
        g.beginPath(); g.moveTo(Math.cos(a)*r0, Math.sin(a)*r0); g.lineTo(Math.cos(a)*190, Math.sin(a)*190); g.stroke();
      }
      const ph = (e % 700) / 700, beat = Math.exp(-ph*9) + .6*Math.exp(-Math.abs(ph - .28)*14);
      const sc = Math.min(1, e/250) * (1 + beat*.12);
      g.scale(sc, sc); g.shadowColor = '#ff2a2a'; g.shadowBlur = 20 + beat*25;
      draw7(g, 0, 4, 84);
      g.restore();
      // 流れるコメント
      if(t > S.nextCom){ S.nextCom = t + 140; S.nico.push({text:pick(TALK.reach), y:rnd(24, 132), x:W + 10, v:rnd(1.8, 3.2), s:rnd(10, 15)}); }
      S.nico = S.nico.filter(n => n.x > -120);
      g.save(); g.textBaseline = 'middle';
      for(const n of S.nico){ n.x -= n.v; g.font = `bold ${n.s}px "M PLUS 1p", sans-serif`;
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(n.text, n.x, n.y); g.fillStyle = '#fff'; g.fillText(n.text, n.x, n.y); }
      g.restore();
      drawCapy(g, 38 + Math.sin(t/25)*1.5, 132, .45, 'shock', t);
      S.viewers += 3;
    }

    function drawFireworks(t){
      if(t > S.nextFw){
        S.nextFw = t + rnd(250, 500);
        const cx = rnd(40, W-40), cy = rnd(24, 80), hue = rnd(0,360);
        for(let k=0;k<36;k++){ const a = k/36*6.283, sp = rnd(.8,1.6);
          S.fireworks.push({x:cx, y:cy, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, life:1, hue}); }
        if(Math.random() < .5) sfx.firework();
      }
      S.fireworks = S.fireworks.filter(p => p.life > 0);
      for(const p of S.fireworks){ p.x += p.vx; p.y += p.vy; p.vy += .02; p.life -= .018;
        g.fillStyle = `hsla(${p.hue},100%,65%,${p.life})`; g.fillRect(p.x, p.y, 2, 2); }
    }
    function drawText(text, y, size, color='#fff', glow='#ff3ea5'){
      g.save(); g.textAlign = 'center'; g.font = `${size}px Limelight, serif`;
      g.fillStyle = color; g.shadowColor = glow; g.shadowBlur = 10; g.fillText(text, W/2, y); g.restore();
    }

    // --- ボーナス中キャラ：拍に合わせて踊る ---
    function drawHeroine(t, x, bottom, h, mood='dance'){
      if(!(HEROINE.complete && HEROINE.naturalWidth)) return;
      const w = h * HEROINE.naturalWidth / HEROINE.naturalHeight;
      const beat = t / 1000 * 132 / 60, ph = beat % 1;
      let rot = Math.sin(beat * Math.PI) * .08, y = bottom, sx = 1, sy = 1;
      if(mood === 'dance'){ y -= Math.abs(Math.sin(beat * Math.PI)) * 5; sy = 1 - Math.exp(-ph*7)*.04; sx = 1 + Math.exp(-ph*7)*.03; }
      if(mood === 'happy'){ y -= Math.abs(Math.sin(t/140)) * 12; rot = Math.sin(t/140) * .12; }
      g.save(); g.translate(x, y); g.rotate(rot); g.scale(sx, sy);
      g.drawImage(HEROINE, -w/2, -h, w, h); g.restore();
      // シャンパンの泡
      if(Math.random() < .25) S.gisiFx.push({kind:'bub', x:x - w*.28 + (Math.random()-.5)*8, y:bottom - h*.85, life:1});
    }

    // --- 擬似連のおじいちゃん：段が進むたびに大きくなって「おーーい！」 ---
    const easeBack = x => 1 + 2.7*Math.pow(x-1,3) + 1.7*Math.pow(x-1,2);
    function drawOjii(t){
      if(!S.gisi || !(OJII.complete && OJII.naturalWidth)) return;
      const e = t - S.gisiT, stay = S.gisi === 5 ? 2600 : 1700;
      if(e > stay + 400) return;
      const sizeOf = n => n ? 50 + (n - 1)*10 : 0;               // ①50 → ⑤90（擬似連の文字の邪魔にならない大きさ）
      const k = Math.min(1, e/320);
      const prev = sizeOf(S.gisi - 1), target = sizeOf(S.gisi);
      let h = prev + (target - prev) * easeBack(k);
      if(S.gisi === 1) h = target * easeBack(k);
      const leave = e > stay ? (e - stay)/400 : 0;             // 最後の段のあとで下に引っ込む
      const w = h * OJII.naturalWidth / OJII.naturalHeight;
      const x = 284 + Math.sin(t/90)*(e < 900 ? 1.5 : 0), bottom = 164 + leave*h;
      g.save(); g.translate(x, bottom); g.rotate(Math.sin(t/300)*.04);
      g.drawImage(OJII, -w/2, -h, w, h); g.restore();
      // 段が変わるたびに小さな吹き出し（擬似連の文字より上、右側）
      if(e > 120 && e < 1000){
        const bk = Math.min(1, (e - 120)/140), sc = .5 + .5*bk;
        g.save(); g.translate(Math.min(286, x - w*.15), 40); g.scale(sc, sc); g.rotate(-.06);
        g.beginPath();
        for(let i=0;i<18;i++){ const a = i/18*6.283, r = i%2 ? 13 : 18; g.lineTo(Math.cos(a)*r*1.75, Math.sin(a)*r*.8); }
        g.closePath(); g.fillStyle = '#FFE14D'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#1a1a1a'; g.stroke();
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '900 10px "M PLUS 1p", sans-serif';
        g.lineJoin = 'round'; g.lineWidth = 2.5; g.strokeStyle = '#1a1a1a'; g.strokeText('おーーい！', 0, 1);
        g.fillStyle = '#E0102A'; g.fillText('おーーい！', 0, 1);
        g.restore();
      }
    }

    // --- 追いメガポコナイト：紫のユニコーン ---
    function drawUnicorn(x, y, s, t){
      const gal = Math.sin(t/70);
      g.save(); g.translate(x, y); g.scale(s, s);
      g.lineJoin = 'round'; g.lineCap = 'round'; g.lineWidth = 2.2; g.strokeStyle = '#2a0b55';
      // 虹色のしっぽ
      const tg = g.createLinearGradient(-70, -60, -30, -20);
      ['#FF7FD0','#B388FF','#7FD3FF'].forEach((c,i) => tg.addColorStop(i/2, c));
      g.fillStyle = tg; g.beginPath(); g.moveTo(-32, -34);
      g.bezierCurveTo(-58, -46 + gal*3, -74, -24, -62, -6); g.bezierCurveTo(-58, -20, -48, -26, -30, -26); g.closePath(); g.fill(); g.stroke();
      // 脚（ギャロップ）
      g.strokeStyle = '#2a0b55'; g.lineWidth = 8;
      [[-20, gal],[-8, -gal],[14, -gal],[26, gal]].forEach(([lx, ph]) => { g.beginPath(); g.moveTo(lx, -22); g.lineTo(lx + ph*7, 0); g.stroke(); });
      g.strokeStyle = '#8E4FD8'; g.lineWidth = 5;
      [[-20, gal],[-8, -gal],[14, -gal],[26, gal]].forEach(([lx, ph]) => { g.beginPath(); g.moveTo(lx, -22); g.lineTo(lx + ph*7, -1); g.stroke(); });
      g.fillStyle = '#F2C14E'; [[-20, gal],[-8, -gal],[14, -gal],[26, gal]].forEach(([lx, ph]) => g.fillRect(lx + ph*7 - 3, -3, 6, 4));
      g.lineWidth = 2.2; g.strokeStyle = '#2a0b55';
      // 体・首・頭
      const bg = g.createLinearGradient(0, -52, 0, -10); bg.addColorStop(0, '#C9A2FF'); bg.addColorStop(1, '#7A3DD6');
      g.fillStyle = bg;
      g.beginPath(); g.ellipse(2, -32, 34, 17, 0, 0, 6.283); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(16, -42); g.lineTo(30, -70); g.lineTo(44, -64); g.lineTo(34, -30); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.ellipse(44, -70, 15, 10, .35, 0, 6.283); g.fill(); g.stroke();
      g.fillStyle = '#E4D2FF'; g.beginPath(); g.ellipse(54, -65, 7, 6, .35, 0, 6.283); g.fill(); g.stroke();
      g.fillStyle = '#2a0b55'; g.beginPath(); g.arc(42, -73, 2.2, 0, 6.283); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(42.8, -73.8, .8, 0, 6.283); g.fill();
      g.fillStyle = '#FF9BC8'; g.beginPath(); g.ellipse(47, -67, 3, 1.8, .3, 0, 6.283); g.fill();
      // 耳
      g.fillStyle = '#9B5CFF'; g.beginPath(); g.moveTo(33, -78); g.lineTo(34, -90); g.lineTo(40, -80); g.closePath(); g.fill(); g.stroke();
      // 角（金のらせん）
      g.fillStyle = '#FFD84A'; g.beginPath(); g.moveTo(40, -80); g.lineTo(54, -106); g.lineTo(47, -77); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = '#C98A06'; g.lineWidth = 1.4;
      for(let k=0;k<3;k++){ const yy = -84 - k*6; g.beginPath(); g.moveTo(42 + k*2.6, yy); g.lineTo(48 + k*2.2, yy - 2.5); g.stroke(); }
      // たてがみ
      g.lineWidth = 2.2; g.strokeStyle = '#2a0b55';
      ['#FF7FD0','#FFB3E6','#7FD3FF','#FF7FD0'].forEach((c, k) => {
        g.fillStyle = c; g.beginPath(); g.ellipse(26 - k*4, -76 + k*11 + gal*1.2, 7, 9, -.6, 0, 6.283); g.fill(); g.stroke();
      });
      g.restore();
      // キラキラ
      for(let k=0;k<6;k++){ const a = t/250 + k*1.05, r = 44*s; sparkle(x + Math.cos(a)*r*1.2, y - 50*s + Math.sin(a)*r*.7, 3 + (k%2)*2, k%2 ? '#FFE14D' : '#FFB3E6'); }
    }
    function sparkle(x, y, r, color){
      g.save(); g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 8;
      g.beginPath(); g.moveTo(x, y-r); g.quadraticCurveTo(x, y, x+r, y); g.quadraticCurveTo(x, y, x, y+r);
      g.quadraticCurveTo(x, y, x-r, y); g.quadraticCurveTo(x, y, x, y-r); g.fill(); g.restore();
    }

    // --- 大当たり確定時の「◯◯を狙え！！」告知 ---
    function drawAimBanner(t){
      const key = S.aim, blink = Math.floor(t/350) % 2 === 0;
      g.save();
      g.fillStyle = 'rgba(20,0,10,.78)'; g.strokeStyle = blink ? '#FFE14D' : '#FF2D55'; g.lineWidth = 2;
      rrPath(g, 58, 23, 204, 30, 8); g.fill(); g.stroke();
      if(key === 'S7') for(let k=0;k<3;k++) draw7(g, 82 + k*22, 38, 24);
      else for(let k=0;k<3;k++){
        g.fillStyle = '#161616'; g.fillRect(70 + k*25, 30, 22, 14); g.strokeStyle = '#F2C14E'; g.lineWidth = 1.5; g.strokeRect(70 + k*25, 30, 22, 14);
        g.fillStyle = '#F2C14E'; g.font = 'bold 7px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BAR', 81 + k*25, 37.5);
      }
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = 'bold 15px "M PLUS 1p", sans-serif';
      g.lineWidth = 3; g.strokeStyle = '#000'; g.strokeText('を狙え！！', 150, 38);
      g.fillStyle = blink ? '#FFE14D' : '#fff'; g.fillText('を狙え！！', 150, 38);
      g.restore();
    }

    // --- カットイン（緑＜赤＜虹） ---
    const CUT_TEXT = {green:'ねぇええええ', red:'燃やすよぉ〜🔥', rainbow:'アルマンド〜🔥'};
    function drawCutin(t){
      const e = t - S.cutT, D = 1500;
      if(e > D){ S.cut = null; return; }
      const inK = Math.min(1, e/180), out = e > D - 200 ? (D - e)/200 : 1;
      g.save(); g.globalAlpha = out;
      g.save(); g.translate(W/2, H/2); g.rotate(-.12);
      const bw = W * 1.4 * inK;
      let fill;
      if(S.cut === 'green') fill = '#12B24A';
      else if(S.cut === 'red') fill = '#E0102A';
      else { fill = g.createLinearGradient(-W*.7, 0, W*.7, 0); const o = (t/6) % 360;
        for(let k=0;k<=6;k++) fill.addColorStop(k/6, `hsl(${(o + k*60) % 360},95%,58%)`); }
      g.fillStyle = fill; g.fillRect(-bw/2, -48, bw, 96);
      g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(-bw/2, -52, bw, 4); g.fillRect(-bw/2, 48, bw, 4);
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2;
      for(let k=0;k<10;k++){ const x = ((k*47 - e*.6) % (W*1.4) + W*1.4) % (W*1.4) - W*.7; g.beginPath(); g.moveTo(x, -40 + k*8); g.lineTo(x - 40, -40 + k*8); g.stroke(); }
      g.restore();
      // キャラが左から滑り込む
      const cx = -40 + Math.min(1, e/260) * 110;
      drawHeroineStatic(cx, 150, 120, e);
      // セリフ
      const tk = Math.min(1, Math.max(0, (e - 160)/200));
      g.save(); g.translate(W - 10 + (1 - tk)*120, 86); g.rotate(-.12);
      g.textAlign = 'right'; g.textBaseline = 'middle'; g.font = `900 ${S.cut === 'rainbow' ? 25 : 27}px "M PLUS 1p", sans-serif`;
      g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = '#1a0008'; g.strokeText(CUT_TEXT[S.cut], 0, 0);
      g.fillStyle = S.cut === 'rainbow' ? '#FFE14D' : '#fff'; g.fillText(CUT_TEXT[S.cut], 0, 0);
      g.restore();
      g.restore();
    }
    function drawHeroineStatic(x, bottom, h, e){
      if(!(HEROINE.complete && HEROINE.naturalWidth)) return;
      const w = h * HEROINE.naturalWidth / HEROINE.naturalHeight, sc = 1 + Math.max(0, .15 - e/1500);
      g.save(); g.translate(x, bottom); g.scale(sc, sc); g.drawImage(HEROINE, -w/2, -h, w, h); g.restore();
    }

    // --- 擬似連ステップアップ ---
    const GISI = [null,
      {text:'追いハート❤',        color:'#FF4F8B'},
      {text:'追い花火🎇',          color:'#FF9A2E'},
      {text:'追い魔法のお城🏰',    color:'#9B5CFF'},
      {text:'追い馬車🎃',          color:'#FF7A00'},
      {text:'追いメガポコナイト〜🔥', color:'#FF1E3C'}];
    function drawCastle(x, base, k){
      g.save(); g.globalAlpha = Math.max(0, k);
      const gr = g.createLinearGradient(0, base - 80, 0, base); gr.addColorStop(0, '#E9D7FF'); gr.addColorStop(1, '#A77BFF');
      g.fillStyle = gr;
      g.fillRect(x - 40, base - 44, 80, 44);
      [[-40,64,14],[26,64,14],[-10,82,20]].forEach(([dx,hh,ww]) => {
        g.fillStyle = gr; g.fillRect(x + dx, base - hh, ww, hh);
        g.fillStyle = '#FF7FB0'; g.beginPath(); g.moveTo(x + dx - 3, base - hh); g.lineTo(x + dx + ww/2, base - hh - 18); g.lineTo(x + dx + ww + 3, base - hh); g.fill();
      });
      g.fillStyle = '#5a2a8a'; g.beginPath(); g.arc(x, base - 12, 9, Math.PI, 0); g.fill(); g.fillRect(x - 9, base - 12, 18, 12);
      g.fillStyle = '#FFE38A'; [[-28,-34],[30,-34],[0,-60]].forEach(([dx,dy]) => g.fillRect(x + dx - 3, base + dy, 6, 8));
      g.restore();
    }
    function drawCarriage(x, y){
      g.save();
      g.fillStyle = '#FF8A1E'; g.beginPath(); g.ellipse(x, y - 26, 30, 22, 0, 0, 6.283); g.fill();
      g.strokeStyle = '#D96400'; g.lineWidth = 2; [-14,0,14].forEach(dx => { g.beginPath(); g.ellipse(x + dx, y - 26, 8, 21, 0, 0, 6.283); g.stroke(); });
      g.fillStyle = '#FFE38A'; rrPath(g, x - 9, y - 36, 18, 14, 5); g.fill();
      g.fillStyle = '#4CAF50'; g.fillRect(x - 2, y - 54, 4, 8);
      g.strokeStyle = '#F2C14E'; g.lineWidth = 3;
      [-18, 18].forEach(dx => { g.beginPath(); g.arc(x + dx, y - 4, 9, 0, 6.283); g.stroke();
        for(let k=0;k<4;k++){ const a = k*Math.PI/4 + x/9; g.beginPath(); g.moveTo(x + dx, y - 4); g.lineTo(x + dx + Math.cos(a)*9, y - 4 + Math.sin(a)*9); g.stroke(); } });
      g.restore();
    }
    function drawGisi(t){
      const e = t - S.gisiT, step = S.gisi, D = step === 5 ? 2000 : 1150;
      if(step > 0 && S.mode === 'spin'){
        g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; rrPath(g, 6, 24, 54, 14, 7); g.fill();
        g.fillStyle = '#FFE14D'; g.font = 'bold 9px "M PLUS 1p", sans-serif'; g.textBaseline = 'middle'; g.fillText(`擬似連×${step + 1}`, 11, 31); g.restore();
      }
      S.gisiFx = S.gisiFx.filter(p => p.life > 0);
      for(const p of S.gisiFx){
        p.life -= p.kind === 'bub' ? .02 : .018;
        g.globalAlpha = Math.max(0, p.life);
        if(p.kind === 'heart'){ p.x += p.vx; p.y += p.vy; p.vy += .02; g.fillStyle = '#FF4F8B'; heartPath(g, p.x, p.y, p.s); g.fill(); }
        if(p.kind === 'fw'){ p.x += p.vx; p.y += p.vy; p.vy += .02; g.fillStyle = `hsl(${p.hue},100%,65%)`; g.fillRect(p.x, p.y, 2.2, 2.2); }
        if(p.kind === 'bub'){ p.y -= .6; p.x += Math.sin(p.y/5)*.3; g.globalAlpha *= .8; g.strokeStyle = '#fff'; g.lineWidth = .8; g.beginPath(); g.arc(p.x, p.y, 1.6, 0, 6.283); g.stroke(); }
      }
      g.globalAlpha = 1;
      if(e > D || !step) return;
      const k = Math.min(1, e/200), out = e > D - 200 ? (D - e)/200 : 1;
      if(step === 3) drawCastle(78, 132, Math.min(1, e/300) * out);
      if(step === 4){ const x = -40 + e/D * (W + 80); drawCarriage(x, 132 - Math.abs(Math.sin(e/60))*2); }
      if(step === 5){
        const run = Math.min(1, e/700), ux = -60 + run*170, uy = 148 - Math.abs(Math.sin(e/110))*(run < 1 ? 6 : 2);
        g.save(); g.globalAlpha = out;
        // 虹の軌跡
        const rg = g.createLinearGradient(ux - 120, 0, ux, 0); rg.addColorStop(0, 'rgba(155,92,255,0)'); rg.addColorStop(1, 'rgba(255,127,208,.7)');
        g.fillStyle = rg; g.fillRect(ux - 120, uy - 40, 110, 14);
        drawUnicorn(ux, uy, 1.15, t); g.restore();
      }
      if(step === 5){ g.save(); g.globalAlpha = .55*out; const f = g.createLinearGradient(0, H, 0, 0);
        f.addColorStop(0, '#FF3B00'); f.addColorStop(.6, 'rgba(255,40,0,.4)'); f.addColorStop(1, 'rgba(255,0,0,0)'); g.fillStyle = f; g.fillRect(0,0,W,H); g.restore(); }
      const info = GISI[step];
      g.save(); g.globalAlpha = out; g.textAlign = 'center'; g.textBaseline = 'middle';
      const sc = e < 200 ? 1.8 - .8*k : 1;
      g.translate(W/2, 78); g.scale(sc, sc);
      g.font = `900 ${step === 5 ? 20 : 24}px "M PLUS 1p", sans-serif`; g.lineJoin = 'round';
      g.lineWidth = 6; g.strokeStyle = '#fff'; g.strokeText(info.text, 0, 0);
      g.fillStyle = info.color; g.fillText(info.text, 0, 0);
      g.restore();
    }

    // --- AT：イベント配信モード ---
    function drawAT(t){
      const sk = g.createLinearGradient(0,0,0,H);
      sk.addColorStop(0,'#3a0a5a'); sk.addColorStop(1,'#b0145a');
      g.fillStyle = sk; g.fillRect(0,0,W,H);
      g.save(); g.translate(W/2, 150); g.rotate(t/3000);
      for(let k=0;k<16;k++){ g.rotate(Math.PI/8); g.fillStyle = k%2 ? 'rgba(255,215,90,.10)' : 'rgba(255,120,200,.09)';
        g.beginPath(); g.moveTo(0,0); g.lineTo(260,-30); g.lineTo(260,30); g.fill(); }
      g.restore();
      const at = S.at, left = Math.max(0, at.goal - at.paid);
      g.save(); g.textBaseline = 'middle';
      g.fillStyle = at.type === 'S7' ? '#D8192F' : '#161616'; g.strokeStyle = '#F2C14E'; g.lineWidth = 2;
      rrPath(g, 6, 24, 86, 18, 5); g.fill(); g.stroke();
      g.fillStyle = '#fff3b0'; g.font = 'bold 9px "M PLUS 1p", sans-serif'; g.textAlign = 'center';
      g.fillText(at.type === 'S7' ? '7 イベント配信' : 'BAR イベント配信', 49, 33);
      g.textAlign = 'right'; g.font = '9px "M PLUS 1p", sans-serif'; g.fillStyle = '#ffd1ea'; g.fillText('残り', W - 64, 34);
      g.font = '20px DotGothic16, monospace'; g.fillStyle = '#fff'; g.shadowColor = '#ff3ea5'; g.shadowBlur = 8;
      g.fillText(left, W - 22, 33); g.font = '9px "M PLUS 1p", sans-serif'; g.fillText('枚', W - 8, 34);
      g.restore();
      g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(6, H - 8, W - 12, 4);
      g.fillStyle = '#F2C14E'; g.fillRect(6, H - 8, (W - 12) * Math.min(1, at.paid / at.goal), 4);

      if(S.navi && S.mode === 'spin'){
        g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = 'bold 12px "M PLUS 1p", sans-serif'; g.fillStyle = '#fff'; g.fillText('押し順ナビ', W/2, 56);
        const next = S.navi[S.stage];
        S.navi.forEach((reel, n) => {
          const x = W*(1 + reel*2)/6, y = 84, on = reel === next, done = n < S.stage;
          const pulse = on ? 1 + .1*Math.sin(t/80) : 1;
          g.save(); g.translate(x, y); g.scale(pulse, pulse);
          g.fillStyle = done ? 'rgba(255,255,255,.15)' : on ? '#ffe14d' : 'rgba(255,255,255,.85)';
          if(on){ g.shadowColor = '#ffd23a'; g.shadowBlur = 16; }
          g.beginPath(); g.arc(0, 0, 19, 0, 6.283); g.fill();
          g.shadowBlur = 0; g.fillStyle = done ? 'rgba(255,255,255,.4)' : '#8a1050';
          g.font = 'bold 22px "M PLUS 1p", sans-serif'; g.fillText(n + 1, 0, 2);
          g.restore();
        });
        g.restore();
        drawHeroine(t, W/2, 154, 52);
      } else {
        drawHeroine(t, W/2, 156, 104, S.gain > 0 && t - S.gainT < 900 ? 'happy' : 'dance');
      }
      drawGisi(t);
      const ge = t - S.gainT;
      if(ge < 1200 && S.gain > 0){
        g.save(); g.globalAlpha = 1 - ge/1200; g.textAlign = 'center';
        g.font = '24px DotGothic16, monospace'; g.fillStyle = '#fff3b0'; g.shadowColor = '#ff9a00'; g.shadowBlur = 10;
        g.fillText('+' + S.gain, W/2, 132 - ge/40); g.restore();
      }
    }

    // --- 毎フレーム ---
    function frame(t){
      g.setTransform(scale,0,0,scale,0,0);
      // 自然に流れるコメントとハート
      const hype = S.mode === 'spin' && S.scene !== 'walk';
      if(!S.tenpai && t > S.nextCom){
        S.nextCom = t + (hype ? rnd(350, 600) : rnd(1100, 2200));
        comment(pick(hype ? TALK.hype : TALK.calm));
      }
      if(t > S.nextHeart){ S.nextHeart = t + (hype ? 180 : rnd(700, 1400)); hearts(1); }
      S.viewers += (hype ? .6 : .02) * (Math.random() - .3);

      if(S.mode === 'atEnd'){
        drawRoom(t); drawFloor(); drawHeroine(t, W/2, 156, 110, 'happy'); drawMic(); drawGisi(t);
        g.fillStyle = 'rgba(40,0,40,.45)'; g.fillRect(0,0,W,H);
        drawText('EVENT CLEAR', 50, 24, '#fff3b0');
        g.save(); g.textAlign = 'center'; g.font = 'bold 14px "M PLUS 1p", sans-serif'; g.fillStyle = '#fff';
        g.fillText(`獲得 ${S.endInfo.paid}枚`, W/2, 76); g.restore();
        drawUI(t); return;
      }
      if(S.at && S.mode !== 'big'){ drawAT(t); drawUI(t); if(S.cut) drawCutin(t); return; }
      if(S.mode === 'big'){
        drawRoom(t);
        drawFloor(); drawHero(t, 'jump'); drawMic();
        g.fillStyle = 'rgba(30,0,30,.35)'; g.fillRect(0,0,W,H);
        drawFireworks(t);
        drawText(S.bigKey === 'S7' ? 'JACKPOT!!' : 'BIG WIN!', 58, 32, '#fff3b0');
        if(Math.random() < .08) comment(pick(TALK.win));
        if(Math.random() < .3) hearts(1, true);
        drawUI(t); return;
      }
      if(S.tenpai){ drawTenpai(t); drawUI(t); if(S.cut) drawCutin(t); return; }

      drawRoom(t);
      const sc = S.scene;
      // キャラの表情
      let mood = (t - S.talkT) % 5200 < 1600 ? 'talk' : 'idle';
      if(S.mode === 'spin' && sc !== 'walk') mood = 'look';
      if(S.mode === 'result' && S.result){
        const r = S.result;
        if(r.flag && r.hit && r.flag !== 'RPL') mood = 'happy';
        if((sc === 'hokuto' || sc.startsWith('chest')) && !BIG.includes(r.flag) && !(r.flag && sc.startsWith('chest'))) mood = 'sad';
      }
      if(t - S.shockT < 1500) mood = 'shock';
      if(t - S.jumpT < 900) mood = 'happy';
      drawFloor(); drawHero(t, mood); drawMic();

      if((sc === 'meteor' || sc === 'meteorGold') && S.mode === 'spin' && !S.burst && t - S.t0 > 200){
        S.burst = true; hearts(sc === 'meteorGold' ? 26 : 16, sc === 'meteorGold');
        comment(sc === 'meteorGold' ? '✨金ハート連打✨' : 'ハート連打！', pick(VIEWERS));
      }
      if(sc.startsWith('chest')) drawGift(t, S.mode === 'result' ? Math.min(1, (t - S.resT)/250) : 0);
      if(sc === 'hokuto') drawRank(t);
      drawOjii(t);
      drawGisi(t);
      drawUI(t);
      if(S.aim) drawAimBanner(t);
      if(S.cut) drawCutin(t);
      if(S.mode === 'idle' && !S.aim && Math.floor(t/700) % 2) drawText('PRESS SPIN', 17, 11, '#fff', '#ff2d55');
    }
    function loop(t){ if(!document.hidden) frame(t); requestAnimationFrame(loop); }

    return {
      resize,
      tenpai(on){ S.tenpai = on; S.tenpaiT = performance.now(); S.nico = []; },
      setAT(at){ S.at = at; },
      startAT(navi){ Object.assign(S, {mode:'spin', scene:'walk', navi, stage:0, tenpai:false, gain:0, gisi:0, cut:null}); },
      resultAT(gain){ Object.assign(S, {mode:'result', gain, gainT:performance.now()}); if(gain > 0){ hearts(4); comment(pick(TALK.win)); } },
      atEnd(info){ Object.assign(S, {mode:'atEnd', at:null, endInfo:info}); },
      react(){ S.shockT = performance.now(); comment('えっ!?', pick(VIEWERS)); },
      start(scene){
        Object.assign(S, {mode:'spin', scene, t0:performance.now(), stage:0, result:null, tenpai:false, burst:false, gisi:0, cut:null,
          rankNow:RANKS[0], gifter:pick(VIEWERS), talkT:performance.now()});
        if(scene === 'meteor' || scene === 'meteorGold') setTimeout(() => sfx.meteor(scene === 'meteorGold'), 200);
        if(scene.startsWith('chest')) setTimeout(sfx.chestDrop, 420);
        if(scene === 'hokuto') sfx.starPing(0);
      },
      stage(){
        S.stage++;
        if(S.scene.startsWith('chest')) sfx.rattle(S.stage);
        if(S.scene === 'hokuto' && !S.at) sfx.starPing(S.stage*2);
      },
      resolve(result){
        Object.assign(S, {mode:'result', result, resT:performance.now(), tenpai:false});
        if(S.scene.startsWith('chest')) sfx.chestOpen(!!result.flag);
        if(S.scene === 'hokuto') (BIG.includes(result.flag) ? sfx.hokutoWin : sfx.hokutoFail)();
        if(result.hit && result.flag && result.flag !== 'RPL'){ S.jumpT = performance.now(); hearts(6); comment(pick(TALK.win)); }
        else if(S.scene !== 'walk' && !result.hit) comment(pick(TALK.lose));
      },
      big(key){ Object.assign(S, {mode:'big', bigKey:key, fireworks:[], nextFw:0, tenpai:false}); hearts(20, true); },
      idle(){ S.mode = 'idle'; S.scene = 'walk'; },
      get mode(){ return S.mode; },
      setAim(key){ S.aim = key; },
      cutin(type){ S.cut = type; S.cutT = performance.now(); },
      gisi(step){
        S.gisi = step; S.gisiT = performance.now();
        const rnd2 = (a,b) => a + Math.random()*(b-a);
        if(step === 1) for(let k=0;k<26;k++) S.gisiFx.push({kind:'heart', x:rnd2(20,300), y:rnd2(110,160), vx:rnd2(-.6,.6), vy:rnd2(-2.6,-1.2), s:rnd2(4,8), life:1});
        if(step === 2) for(let b=0;b<3;b++){ const cx = rnd2(50,270), cy = rnd2(30,80), hue = rnd2(0,360);
          for(let k=0;k<30;k++){ const a = k/30*6.283, sp = rnd2(.8,1.8); S.gisiFx.push({kind:'fw', x:cx, y:cy, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, hue, life:1}); } }
        comment(GISI[step].text, pick(VIEWERS));
      },
      run(){ resize(); comment('配信はじめるよ〜', ['🎤','配信主']); requestAnimationFrame(loop); }
    };
  })();

  // ================================================================
  // 8-3. 激アツ演出（画面全体を覆うカットイン）
  // ================================================================
  const geki = (() => {
    const cv = $('gekiatsu'), c = cv.getContext('2d');
    let active = false, t0 = 0, last = 0, dur = GEKI_DUR, dpr = 1, lanes = [], lineNo = 0, aiTimer = null;
    const easeBack = x => 1 + 2.7*Math.pow(x-1,3) + 1.7*Math.pow(x-1,2);
    const LINES_TXT = ['燃やすよ〜🔥','やめなぁ〜🔥','D帯で病むな🫵','屁が出るうちはまだ病んでないね','激アツ',
                       'っしゃオラァアアアア','なんだ橋口か','これってお忍びですか？','ファミリー全員集合',
                       '素飲みは帰れ〜','朝８時に病院同伴ってなに','ねぇ、テレビの音でかくない？','ねぇえええええ',
                       'グルテンフリーにしては美味しいパンかもね','なに、こないだ来たおじ客がどした？'];
    const COLORS = ['#fff','#FFE14D','#fff','#FF9BC8'];
    let title = '激アツ';
    // セリフを流す段（y位置は固定）。段ごとに速さを変え、同じ段では前のセリフと間隔をあける
    const LANE_Y = [.07, .17, .27, .37, .47, .57, .67, .77, .9];
    function start(opt = {}){
      if(active) return;
      title = opt.title || '激アツ';
      dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
      dur = reduceMotion ? 4000 : GEKI_DUR;
      lineNo = 0;
      lanes = LANE_Y.map((y, i) => ({y, items:[], speed:.24 + (i % 3)*.07, startAt:i*140}));
      active = true; t0 = last = performance.now(); cv.hidden = false;
      sfx.gekiatsu();
      // 全画面になってから1秒後に「愛してる」
      clearTimeout(aiTimer); aiTimer = setTimeout(() => { if(active) sfx.aishiteru(); }, 1000);
      requestAnimationFrame(loop);
    }
    function stop(){ if(active){ t0 = performance.now() - dur + 300; } }
    function loop(t){
      const e = t - t0, w = innerWidth, h = innerHeight, u = Math.min(w, h);
      c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,w,h);
      const fade = e > dur - 300 ? Math.max(0, (dur - e)/300) : 1;
      c.globalAlpha = Math.min(1, e/120) * fade;
      const bg = c.createRadialGradient(w/2, h*.45, 0, w/2, h*.45, Math.max(w,h)*.75);
      bg.addColorStop(0, '#FF3B3B'); bg.addColorStop(.45, '#B0001E'); bg.addColorStop(1, '#2A0008');
      c.fillStyle = bg; c.fillRect(0,0,w,h);
      // 集中線
      c.save(); c.translate(w/2, h*.42);
      for(let k=0;k<60;k++){
        const a = k/60*6.283 + (k%2 ? e/1800 : -e/2400), r0 = u*(.18 + (k*37%20)/100);
        c.strokeStyle = `rgba(255,${200 + (k%3)*20},${120 + (k%4)*30},${.2 + (k%4)*.08})`; c.lineWidth = k%3 ? 2 : 5;
        c.beginPath(); c.moveTo(Math.cos(a)*r0, Math.sin(a)*r0); c.lineTo(Math.cos(a)*u*1.4, Math.sin(a)*u*1.4); c.stroke();
      }
      c.restore();
      // キャラが飛び込んでくる
      const shake = reduceMotion || e < 500 ? 0 : 5;
      const sx = (Math.random()-.5)*shake, sy = (Math.random()-.5)*shake;
      // 流れるセリフ（段ごとに順番に流す）
      const dt = Math.min(50, t - last); last = t;
      const fs = Math.round(Math.min(u*.062, 34));
      c.font = `900 ${fs}px "M PLUS 1p", sans-serif`; c.textBaseline = 'middle';
      lanes.forEach(L => {
        if(e < L.startAt) return;
        const tail = L.items[L.items.length - 1];
        if(!tail || tail.x + tail.w < w - fs*2.2){
          const text = LINES_TXT[lineNo++ % LINES_TXT.length];
          L.items.push({text, x:w + 8, w:c.measureText(text).width, color:COLORS[lineNo % COLORS.length]});
        }
        L.items.forEach(n => n.x -= L.speed * w * dt/1000);
        L.items = L.items.filter(n => n.x + n.w > -10);
        L.items.forEach(n => {
          c.lineJoin = 'round'; c.lineWidth = Math.max(3, fs*.16); c.strokeStyle = 'rgba(0,0,0,.8)'; c.strokeText(n.text, n.x, L.y*h);
          c.fillStyle = n.color; c.fillText(n.text, n.x, L.y*h);
        });
      });
      const k = Math.min(1, e/520), ih = u * .72 * (.35 + .65*easeBack(k));
      if(TUX.complete && TUX.naturalWidth){
        const iw = ih * TUX.naturalWidth / TUX.naturalHeight;
        c.save(); c.translate(w/2 + sx, h*.4 + sy); c.rotate(Math.sin(e/160)*.03);
        c.drawImage(TUX, -iw/2, -ih/2, iw, ih); c.restore();
        // 「愛してる」の吹き出し（音源と同じく1秒後から表示）
        const be = e - 1000;
        if(be > 0 && be < 2200){
          const pk = Math.min(1, be/160), pop = pk < 1 ? .3 + .9*pk : 1 + .03*Math.sin(be/90);
          const out = be > 1900 ? (2200 - be)/300 : 1;
          const bfs = Math.round(Math.min(u*.09, 44));
          c.font = `900 ${bfs}px "M PLUS 1p", sans-serif`;
          const tw = c.measureText('愛してる❤').width, bw = tw + bfs*1.1, bh = bfs*1.7;
          // キャラの頭の右上あたり（画面からはみ出さないように）
          let bx = w/2 + iw*.28, by = h*.4 - ih/2 - bh*.55;  // 頭の上（顔にかからない位置）
          bx = Math.min(w - bw/2 - 10, Math.max(bw/2 + 10, bx)); by = Math.max(bh/2 + 10, by);
          c.save(); c.globalAlpha *= out; c.translate(bx + sx, by + sy); c.scale(pop, pop); c.rotate(-.05);
          // しっぽ（キャラの口元方向）
          c.fillStyle = '#fff'; c.strokeStyle = '#FF2D78'; c.lineWidth = Math.max(3, bfs*.09); c.lineJoin = 'round';
          c.beginPath(); c.moveTo(-bw*.28, bh*.35); c.lineTo(-bw*.5, bh*.95); c.lineTo(-bw*.08, bh*.42); c.closePath(); c.fill(); c.stroke();
          c.beginPath();
          const r = bh/2;
          c.moveTo(-bw/2 + r, -bh/2); c.lineTo(bw/2 - r, -bh/2); c.arc(bw/2 - r, 0, r, -Math.PI/2, Math.PI/2);
          c.lineTo(-bw/2 + r, bh/2); c.arc(-bw/2 + r, 0, r, Math.PI/2, Math.PI*1.5); c.closePath();
          c.shadowColor = 'rgba(255,45,120,.6)'; c.shadowBlur = 16; c.fill(); c.shadowBlur = 0; c.stroke();
          // しっぽと本体のつなぎ目を消す
          c.beginPath(); c.moveTo(-bw*.27, bh*.36); c.lineTo(-bw*.1, bh*.41); c.lineWidth = c.lineWidth*1.6; c.strokeStyle = '#fff'; c.stroke();
          c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#FF2D78';
          c.fillText('愛してる❤', 0, bfs*.05);
          c.restore();
        }
      }
      // 「激アツ」ロゴ
      if(e > 280){
        const p = Math.min(1, (e - 280)/220), pop = p < 1 ? 2.2 - 1.2*p : 1 + .04*Math.sin(e/60);
        let fs = Math.min(w*.26, h*.2, 150);
        c.font = `900 ${fs}px "M PLUS 1p", sans-serif`;
        const tw = c.measureText(title).width; if(tw > w*.92) fs *= w*.92/tw;
        c.save(); c.translate(w/2 + sx*1.5, h*.78 + sy*1.5); c.scale(pop, pop); c.rotate(-.06);
        c.font = `900 ${fs}px "M PLUS 1p", sans-serif`; c.textAlign = 'center';
        const gr = c.createLinearGradient(0, -fs/2, 0, fs/2);
        gr.addColorStop(0, '#FFFBE6'); gr.addColorStop(.45, '#FFD23A'); gr.addColorStop(.55, '#E08A00'); gr.addColorStop(1, '#FFE9A0');
        c.lineJoin = 'round'; c.lineWidth = fs*.2; c.strokeStyle = '#3A0008'; c.strokeText(title, 0, 0);
        c.lineWidth = fs*.1; c.strokeStyle = '#FF2D2D'; c.strokeText(title, 0, 0);
        c.fillStyle = gr; c.shadowColor = '#FFD23A'; c.shadowBlur = 30; c.fillText(title, 0, 0);
        c.restore();
      }
      // 最初の白フラッシュ
      if(e < 180){ c.globalAlpha = 1 - e/180; c.fillStyle = '#fff'; c.fillRect(0,0,w,h); }
      c.globalAlpha = 1;
      if(e < dur) requestAnimationFrame(loop);
      else { active = false; cv.hidden = true; c.clearRect(0,0,w,h); }
    }
    // 表示中にタップすると早めに終了
    cv.addEventListener('click', stop);
    return {start, stop, get active(){ return active; }};
  })();

  // ================================================================
  // 9. 画面全体のエフェクト（コイン・紙吹雪）
  // ================================================================
  const fxCanvas = $('fx'), g2 = fxCanvas.getContext('2d');
  let parts = [], fxRunning = false, dpr = 1;
  function resizeFx(){
    dpr = Math.min(2, window.devicePixelRatio || 1);
    fxCanvas.width = innerWidth * dpr; fxCanvas.height = innerHeight * dpr;
  }
  const COLORS = ['#ff3b3b','#ffb03b','#fff04d','#4dff88','#4dd2ff','#ff3ea5','#ffffff'];
  function spawn(n, kind, from='top'){
    if(reduceMotion) return;
    for(let k=0;k<n;k++){
      const burst = from !== 'top';
      parts.push({
        kind, x: burst ? from.x : Math.random()*innerWidth, y: burst ? from.y : -20 - Math.random()*innerHeight*.5,
        vx: burst ? (Math.random()-.5)*14 : (Math.random()-.5)*2,
        vy: burst ? -6 - Math.random()*10 : 2 + Math.random()*3,
        rot: Math.random()*6.28, vr: (Math.random()-.5)*.4,
        size: kind === 'coin' ? 9 + Math.random()*6 : 5 + Math.random()*5,
        color: COLORS[k % COLORS.length], life: 0
      });
    }
    if(!fxRunning){ fxRunning = true; requestAnimationFrame(fxLoop); }
  }
  function fxLoop(){
    g2.setTransform(dpr,0,0,dpr,0,0);
    g2.clearRect(0,0,innerWidth,innerHeight);
    parts = parts.filter(p => p.y < innerHeight + 40 && p.life < 600);
    for(const p of parts){
      p.life++; p.vy += p.kind === 'coin' ? .35 : .12; p.vx *= .99;
      if(p.kind === 'confetti') p.vy = Math.min(p.vy, 3.2);
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      g2.save(); g2.translate(p.x, p.y);
      if(p.kind === 'coin'){
        const sx = Math.abs(Math.cos(p.rot)) * p.size + 1;
        g2.fillStyle = '#F2C14E'; g2.strokeStyle = '#9A6A12'; g2.lineWidth = 2;
        g2.beginPath(); g2.ellipse(0,0,sx,p.size,0,0,6.283); g2.fill(); g2.stroke();
        g2.fillStyle = 'rgba(255,248,210,.7)'; g2.beginPath(); g2.ellipse(-sx*.3,-p.size*.35,sx*.3,p.size*.25,0,0,6.283); g2.fill();
      } else {
        g2.rotate(p.rot); g2.fillStyle = p.color; g2.fillRect(-p.size/2,-p.size/4,p.size,p.size/2);
      }
      g2.restore();
    }
    if(parts.length) requestAnimationFrame(fxLoop);
    else { fxRunning = false; g2.clearRect(0,0,innerWidth,innerHeight); }
  }
  function windowCenter(){
    const b = document.querySelector('.window').getBoundingClientRect();
    return {x: b.left + b.width/2, y: b.top + b.height/2};
  }
  function party(ms){
    $('topper').classList.add('party');
    clearTimeout(party.t); party.t = setTimeout(() => { if(!state.at) $('topper').classList.remove('party'); }, ms);
  }

  // LUCKY!ランプ（点灯したら7・BAR確定）
  function setPeka(on){
    state.peka = on;
    $('peka').classList.toggle('lit', on);
    $('peka').setAttribute('aria-label', on ? '当選ランプ 点灯' : '当選ランプ 消灯');
  }
  function pekaOn(type){
    state.pekaType = type;
    setPeka(true); sfx.gako(); screen.react();
    const key = BIG.includes(state.flag) ? state.flag : state.carry;
    if(key){ screen.setAim(key); setTimeout(() => { if(state.peka) setMsg(`${key === 'S7' ? '777' : 'BAR・BAR・BAR'}を狙え！！`); }, 50); }
    setMsg('7かBARを狙え！');
    updateUI();
  }

  // 7テンパイ：2つのリールが止まり、有効ライン上に7が2つ並んだ状態
  let heartTimer = null;
  function checkTenpai(){
    if(state.tenpai) return;
    const stopped = reels.map((r,i) => r.spinning ? -1 : i).filter(i => i >= 0);
    const rest = reels.findIndex(r => r.spinning);
    if(stopped.length !== 2 || rest < 0) return;
    const reach = LINES.some(line => stopped.every(i => symAt(i, reels[i].stopPos, line[i]) === 'S7'));
    if(!reach) return;
    state.tenpai = true;
    reels[rest].el.parentElement.classList.add('aori');
    stopBtns[rest].classList.add('aori');
    screen.tenpai(true);
    setMsg('7テンパイ！ 最後のリールを止めろ');
    sfx.tenpai();
    audio.startDrone();
    sfx.heart(); heartTimer = setInterval(sfx.heart, 700);
  }
  function endTenpai(){
    if(!state.tenpai) return false;
    state.tenpai = false;
    clearInterval(heartTimer); audio.stopDrone();
    document.querySelectorAll('.aori').forEach(e => e.classList.remove('aori'));
    screen.tenpai(false);
    return true;
  }

  // ================================================================
  // 10. ゲーム進行
  // ================================================================
  const OJ_NAME = {OJ0:'押し順ぶどう（左→中→右）', OJ1:'押し順ぶどう（中→左→右）', OJ2:'押し順ぶどう（右→左→中）'};
  const flagName = f => f ? (OJ_NAME[f] || SYM[f].name) : 'ハズレ';
  function setMsg(t){ msgEl.textContent = t; }
  function updateUI(){
    $('credit').textContent = state.credits;
    $('payout').textContent = state.payout;
    $('games').textContent = state.games;
    $('rtp').textContent = state.coinIn ? (state.coinOut / state.coinIn * 100).toFixed(1) + '%' : '-';
    const busy = state.phase === 'spinning';
    lever.disabled = !state.ready;
    const locked = performance.now() < (state.lockUntil || 0);
    stopBtns.forEach((b,i) => {
      b.classList.toggle('on', busy && !locked && reels[i].spinning && !reels[i].stopping);
      b.textContent = busy && state.navi ? `STOP ${state.navi.indexOf(i) + 1}` : 'STOP';
    });
    $('dFlag').textContent = state.games ? flagName(state.flag) : '-';
    $('dCarry').textContent = state.carry ? SYM[state.carry].name : 'なし';
    $('dScn').textContent = state.scene ? SCENES[state.scene] : '-';
    $('dExp').textContent = state.scene ? (EXPECT[state.scene]*100).toFixed(1) + '%' : '-';
    $('dGeki').textContent = `期待度 ${(GEKI_EXPECT*100).toFixed(1)}%`;
    $('dCut').textContent = ['green','red','rainbow'].map(c => `${{green:'緑',red:'赤',rainbow:'虹'}[c]} ${(expectOf(f => cutRow(f)[c] || 0)*100).toFixed(0)}%`).join(' / ');
    $('dGisi').textContent = `今回 ${state.gisi ? state.gisi + '段' : 'なし'}（③以上の期待度 ${(expectOf(f => gisiRow(f).slice(3).reduce((a,b)=>a+b,0))*100).toFixed(0)}%）`;
    $('setting').disabled = busy;
    $('dPeka').textContent = state.peka ? `点灯（${state.pekaType}）` : (state.postPeka ? '後ペカ待ち' : '消灯');
    reels.forEach((r,i) => $('dS'+i).textContent = r.slide === null ? '-' : `${r.slide}コマ`);
  }
  function clearWins(){
    document.querySelectorAll('.sym.win').forEach(e => e.classList.remove('win'));
    linesSvg.innerHTML = '';
  }

  let countTimer = null, countLeft = 0;
  function finishCount(){
    if(countTimer){ clearInterval(countTimer); countTimer = null; }
    if(countLeft > 0){ state.credits += countLeft; state.payout += countLeft; countLeft = 0; }
    save(); updateUI();
  }
  function startCount(n, big){
    countLeft = n;
    let k = 0;
    countTimer = setInterval(() => {
      countLeft--; state.payout++; state.credits++; k++;
      if(big){ if(k % 3 === 0) sfx.bell(); $('bwAmount').textContent = '+' + state.payout; }
      else sfx.payTick(k);
      updateUI();
      if(countLeft <= 0){
        finishCount();
        if(big) setTimeout(hideBigWin, 1600);
      }
    }, big ? 22 : 45);
  }
  function showBigWin(key){
    $('bwText').textContent = key === 'S7' ? 'JACKPOT!!' : 'BIG WIN!';
    $('bwAmount').textContent = `AT ${AT_GOAL[key]}枚`;
    setTimeout(sfx.atStart, 1900);
    setTimeout(hideBigWin, 3200);
    $('bigwin').hidden = false;
    if(!reduceMotion){ $('cab').classList.remove('shake'); void $('cab').offsetWidth; $('cab').classList.add('shake'); }
    sfx.jackpot();
    [0,500,1000,1600].forEach(t => setTimeout(() => { spawn(70,'confetti'); spawn(35,'coin'); }, t));
  }
  function hideBigWin(){ $('bigwin').hidden = true; }
  $('bigwin').addEventListener('click', hideBigWin);

  // SPINボタン連打：回転中なら次のリールを左から止める
  function stopNext(){
    if(performance.now() - state.startTs < 180) return; // 押した直後の誤連打を無視
    if(performance.now() < state.lockUntil) return;     // 擬似連中は止められない
    const order = state.navi || [0,1,2];
    const i = order.find(k => reels[k].spinning && !reels[k].stopping);
    if(i !== undefined) stopReel(i);
  }

  function pull(){
    if(!state.ready) return;
    if(state.phase === 'spinning'){ stopNext(); return; }
    audio.init();
    if(audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
    finishCount(); hideBigWin();
    const cost = state.replay ? 0 : BET;
    if(state.credits < cost){
      setMsg('クレジットがありません。リセットで100枚に戻せます');
      sfx.miss();
      return;
    }
    state.credits -= cost;
    state.coinIn += BET;
    if(state.replay) state.coinOut += BET;
    const wasReplay = state.replay;
    state.replay = false;
    state.payout = 0;
    state.games++;

    const dbg = debugSettings();

    // --- 内部抽選（デバッグで固定されていればそれを使う。AT中はAT用テーブル）---
    const auto = state.at ? lottery(AT_TABLE) : (state.carry || lottery());
    state.flag = dbg.flag !== undefined ? dbg.flag : auto;
    // 押し順ぶどうは、最初に押したリールが決まるまで制御上の役が未定
    state.navi = NAVI[state.flag] || null;
    state.ctrlFlag = state.navi ? undefined : state.flag;

    if(state.at){
      state.scene = null;
      screen.startAT(state.navi);
      if(state.navi) setTimeout(sfx.navi, 150);
    } else {
      // --- 液晶演出の抽選（ランプ点灯中は通常演出）---
      state.scene = dbg.scene || (state.peka ? 'walk' : pickScene(state.flag));
      screen.start(state.scene);
    }
    // --- 激アツ演出の抽選（通常時のみ）---
    state.geki = !state.at && !state.peka && (dbg.geki ? dbg.geki === 'on' : Math.random() < gekiRate(state.flag));
    // --- カットイン・擬似連の抽選（通常時のみ）---
    state.cutin = state.at ? null : (dbg.cut ? (dbg.cut === 'none' ? null : dbg.cut) : pickCutin(state.flag));
    state.gisi = state.at || state.peka ? 0 : (dbg.gisi !== null && dbg.gisi !== undefined ? dbg.gisi : pickGisi(state.flag));
    state.gisiDone = 0;
    if(state.gisi === 5) state.geki = false; // ⑤で全画面の激アツが出るので第2停止の激アツは出さない
    // カットインがあるときは、見終わってから擬似連を始める
    state.gisiDelay = state.cutin ? CUT_DUR : 0;
    if(state.cutin){ const type = state.cutin; setTimeout(() => { screen.cutin(type); sfx.cutin(type); }, 60); state.cutin = null; }
    state.lockUntil = state.gisi ? performance.now() + GISI_START + state.gisiDelay + (state.gisi - 1)*GISI_GAP + GISI_FREEZE + 250 : 0;
    // ⑤は液晶で2秒見せたあと全画面の激アツ。終わるまでSTOPを受け付けない
    if(state.gisi === 5) state.lockUntil += GISI5_HOLD;
    if(state.gisi) setTimeout(updateUI, state.lockUntil - performance.now() + 20);

    // --- ランプ（先ペカ／後ペカ）の抽選 ---
    state.postPeka = false;
    if(BIG.includes(state.flag) && !state.peka && !state.at){
      const pre = dbg.peka ? dbg.peka === 'pre' : Math.random() < PRE_PEKA;
      if(pre) setTimeout(() => pekaOn('先ペカ'), 120);
      else state.postPeka = true;
    }

    clearWins();
    reels.forEach(r => { r.spinning = true; r.stopping = false; r.stopPos = null; r.slide = null; });
    state.phase = 'spinning';
    updateMap();
    state.startTs = state.lastTs = performance.now();
    setMsg(state.at ? ''
      : state.peka ? `${(BIG.includes(state.flag) ? state.flag : state.carry) === 'S7' ? '777' : 'BAR・BAR・BAR'}を狙え！！` : 'STOPで止めよう');
    if(!wasReplay) sfx.coin();
    sfx.lever();
    save(); updateUI();
    requestAnimationFrame(loop);
  }

  function stopReel(i){
    const r = reels[i];
    if(state.phase !== 'spinning' || !r.spinning || r.stopping) return;
    if(performance.now() < state.lockUntil) return;
    const base = Math.floor(r.p);
    const stops = reels.map(x => x.stopPos);
    // 押し順ぶどう：最初に止めたリールがナビ通りならぶどう、違えばハズレとして制御
    if(state.ctrlFlag === undefined) state.ctrlFlag = (i === state.navi[0]) ? 'GRP' : null;
    const flag = state.ctrlFlag;
    let d = decideStop(stops, i, base, flag), extra = 0;

    // デバッグ用の目押しアシスト：押した位置から1周先までの押し位置を試し、狙いに一番近いものを選ぶ
    const aim = debugSettings().aim;
    if(aim){
      let best = null;
      for(let k = 0; k < N; k++){
        const c = decideStop(stops, i, mod(base - k, N), flag);
        const next = stops.slice(); next[i] = c.pos;
        const sc = aim === 'flag' ? c.v
          : LINES.filter(line => next.every((p, j) => p === null || symAt(j, p, line[j]) === 'S7')).length;
        if(!best || sc > best.sc + 1e-9) best = {k, c, sc};
      }
      d = best.c; extra = best.k;
    }

    r.stopping = true;
    r.stopPos = d.pos;
    r.slide = d.slide;
    r.remain = (r.p - base) + extra + d.slide;
    screen.stage();
    lastAct = performance.now();
    // 第2停止で激アツ演出
    const pressed = reels.filter(x => x.stopping || !x.spinning).length;
    if(pressed === 2 && state.geki){ state.geki = false; geki.start(); }
    // 3つ目のSTOPを押した瞬間に後ペカ
    const last = reels.every(x => x.stopping || !x.spinning);
    // 第3停止：カットイン
    if(last && state.postPeka){ state.postPeka = false; pekaOn('後ペカ'); }
    updateUI();
  }

  function loop(ts){
    const dt = Math.min(ts - state.lastTs, 50);
    state.lastTs = ts;
    let v = SPEED * Math.min(1, (ts - state.startTs) / 250);
    // 擬似連：各段のタイミングでリールが一瞬止まり、再始動する
    for(let k = 1; k <= state.gisi; k++){
      const b = state.startTs + GISI_START + state.gisiDelay + (k-1)*GISI_GAP;
      if(ts < b) break;
      if(ts < b + GISI_FREEZE){
        v = 0;
        if(state.gisiDone < k){
          state.gisiDone = k;
          reels.forEach(r => { r.p = mod(Math.round(r.p), N); render(r); });
          screen.gisi(k); sfx.gisi(k); setTimeout(sfx.ooi, 120);
          const w = document.querySelector('.window'); w.classList.remove('gshake'); void w.offsetWidth; w.classList.add('gshake');
          if(k === 5) setTimeout(() => geki.start({title:'追いメガポコナイト〜🔥'}), GISI5_HOLD);
        }
      } else v = SPEED * Math.min(1, (ts - b - GISI_FREEZE) / 250);
    }
    let anySpinning = false;
    reels.forEach((r, i) => {
      if(!r.spinning) return;
      let move = v * dt;
      if(r.stopping){ move = Math.min(move, r.remain); r.remain -= move; }
      r.p = mod(r.p - move, N);
      if(i === 0 && Math.floor(r.p) !== r.lastTick){ r.lastTick = Math.floor(r.p); sfx.tick(); }
      if(r.stopping && r.remain <= 1e-9){
        r.p = r.stopPos; r.spinning = false; sfx.stop(i); if(!state.at) checkTenpai();
      } else anySpinning = true;
      render(r);
    });
    if(anySpinning) requestAnimationFrame(loop);
    else finish();
  }

  function finish(){
    state.phase = 'idle';
    lastFinish = performance.now();
    const stops = reels.map(r => r.stopPos);
    const wins = grade(stops);
    const flag = state.ctrlFlag;   // 制御上の役（押し順ぶどうは正解ならGRP、不正解ならnull）
    const hit = wins.some(w => w.key === flag);

    if(!state.at) state.carry = (CARRY_OVER.includes(flag) && !hit) ? flag : null;
    const navi = state.navi; state.navi = null;

    const wasTenpai = endTenpai();
    updateMap();

    wins.forEach(w => {
      w.cols.forEach(c => reels[c].el.children[stops[c] + w.line[c]].classList.add('win'));
      if(w.cols.length === 3){
        const ys = w.line.map(row => 50 + row*100);
        const pts = ys.map((y, c) => `${50 + c*100},${y}`).join(' ');
        linesSvg.insertAdjacentHTML('beforeend',
          `<polyline vector-effect="non-scaling-stroke" points="0,${ys[0] - (ys[1]-ys[0])/2} ${pts} 300,${ys[2] + (ys[2]-ys[1])/2}"/>`);
      }
    });

    const total = wins.reduce((a, w) => a + PAY[w.key], 0);
    if(wins.some(w => w.key === 'RPL')) state.replay = true;
    state.coinOut += total;
    const bigHit = hit && BIG.includes(flag);

    if(bigHit){
      // --- 大当たり：AT突入（AT中に揃えば上乗せ）---
      setPeka(false); state.pekaType = '-'; state.carry = null; screen.setAim(null);
      if(state.at){ state.at.goal += AT_GOAL[flag]; }
      else state.at = {type:flag, goal:AT_GOAL[flag], paid:0};
      screen.setAT(state.at);
      screen.big(flag);
      showBigWin(flag);
      setMsg(`${SYM[flag].name}揃い！ AT突入（${AT_GOAL[flag]}枚まで）`);
      $('topper').classList.add('party');
    } else if(state.at){
      // --- AT中 ---
      state.at.paid += total;
      screen.resultAT(total);
      if(wins.length === 0) setMsg('はずれ');
      else if(state.replay){ setMsg('リプレイ'); sfx.replay(); }
      else { setMsg(`${SYM[wins[0].key].name}　${total}枚`); sfx.smallWin(); }
      if(total > 0) startCount(total, false);
      if(state.at.paid >= state.at.goal){ endAT(); state.skipQueued = false; $('skipBtn').classList.remove('queued'); $('skipBtn').textContent = 'SKIP ▶▶'; }
      else if(state.skipQueued) setTimeout(skipAT, 500);
    } else {
      screen.resolve({flag, hit});
      if(wasTenpai){ sfx.tenpaiFail(); }
      if(wins.length === 0){
        setMsg(state.peka ? `${state.carry === 'S7' ? '777' : 'BAR・BAR・BAR'}を狙え！！` : 'はずれ。SPINでもう一回');
      } else if(state.replay){
        setMsg('リプレイ！次ゲームはベット不要'); sfx.replay();
      } else if(flag === 'WML'){
        setMsg(`スイカ！ ${total}枚獲得`);
        sfx.midWin(); party(1500);
        spawn(30, 'coin', windowCenter());
      } else {
        setMsg(`${SYM[wins[0].key].name}　${total}枚獲得`);
        sfx.smallWin();
        if(flag === 'CHE') spawn(8, 'coin', windowCenter());
      }
      if(total > 0) startCount(total, false);
    }
    save(); updateUI();
  }

  // ================================================================
  // オートプレイ：一定間隔でレバーとSTOPを自動操作
  //   ・ランプが点灯したら自動で止まるので、7・BARは自分で狙う
  //   ・激アツ演出や大当たり表示の間は待つ
  // ================================================================
  let autoOn = false, lastAct = 0, lastFinish = 0;
  function setAuto(on){
    autoOn = on;
    $('autoBtn').setAttribute('aria-pressed', String(on));
  }
  document.addEventListener('pointerdown', () => { audio.init(); if(audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume(); }, {once:true});
  $('autoBtn').addEventListener('click', () => { audio.init(); setAuto(!autoOn); if(autoOn) setMsg('オートプレイ中'); });
  setInterval(() => {
    if(!autoOn || !state.ready || geki.active || !$('bigwin').hidden) return;
    const now = performance.now();
    if(state.peka && !state.at){ setAuto(false); setMsg('ランプ点灯！ オートを止めました。液晶の図柄を狙おう'); return; }
    if(state.phase === 'idle'){
      if(now - lastFinish < (countTimer ? 1200 : 700)) return;
      if(state.credits < BET && !state.replay){ setAuto(false); setMsg('クレジットがなくなったのでオートを止めました'); return; }
      pull(); lastAct = now;
    } else if(now - lastAct > (state.tenpai ? 1800 : 380)){
      stopNext();
    }
  }, 100);

  // ATスキップ：残りのATゲームを一瞬で消化する
  function skipAT(){
    if(!state.at || state.phase === 'spinning') return;
    finishCount();
    const start = state.credits;
    let games = 0;
    while(state.at.paid < state.at.goal){
      const cost = state.replay ? 0 : BET;
      if(state.credits < cost){ setMsg('クレジット不足でスキップを中断しました'); break; }
      state.credits -= cost; state.coinIn += BET; if(state.replay) state.coinOut += BET;
      state.replay = false; games++;
      const f = lottery(AT_TABLE);
      const pay = (f && (f.startsWith('OJ') || f === 'GRP')) ? PAY.GRP : f === 'CHE' ? PAY.CHE : 0;
      if(f === 'RPL') state.replay = true;
      state.at.paid += pay; state.credits += pay; state.coinOut += pay;
    }
    state.games += games;
    state.skipQueued = false; $('skipBtn').classList.remove('queued'); $('skipBtn').textContent = 'SKIP ▶▶';
    clearWins();
    if(state.at.paid >= state.at.goal){
      endAT();
      setTimeout(() => setMsg(`AT終了！ ${games}ゲームをスキップ（差枚 ${state.credits - start >= 0 ? '+' : ''}${state.credits - start}）`), 450);
    }
    save(); updateUI();
  }
  // 回転中に押したら「予約」して、そのゲームが終わってからスキップ
  $('skipBtn').addEventListener('click', () => {
    audio.init();
    if(!state.at) return;
    if(state.phase === 'spinning'){ state.skipQueued = true; $('skipBtn').classList.add('queued'); $('skipBtn').textContent = 'SKIP予約'; return; }
    skipAT();
  });

  // 設定変更
  $('setting').value = state.setting;
  $('setting').addEventListener('change', e => {
    state.setting = +e.target.value; store.set('slot.setting', state.setting);
    applySetting(state.setting); calcExpect(); updateUI();
    setMsg(`設定${state.setting}に変更（理論出玉率 ${SETTINGS[state.setting].rtp}%）`);
  });

  // BGM：通常ステージのときだけ流す
  const bgmBtn = $('bgmBtn');
  const syncBgmBtn = () => bgmBtn.textContent = state.bgm ? 'BGM：オン' : 'BGM：オフ';
  bgmBtn.addEventListener('click', () => { audio.init(); state.bgm = !state.bgm; store.set('slot.bgm', state.bgm); syncBgmBtn(); });
  syncBgmBtn();
  setInterval(() => {
    const normal = state.sound && state.bgm && audio.ctx && !state.at && !state.tenpai && !geki.active
      && $('bigwin').hidden && !['big','atEnd'].includes(screen.mode);
    if(normal) bgm.start(); else bgm.stop();
    $('skipBtn').hidden = !state.at;
  }, 200);

  function endAT(){
    const info = {type:state.at.type, paid:state.at.paid};
    state.at = null;
    screen.atEnd(info);
    $('topper').classList.remove('party');
    setTimeout(() => { sfx.atEnd(); setMsg(`AT終了！ 獲得 ${info.paid}枚`); }, 400);
  }

  // デバッグ設定（パネルを開いている間だけ有効）
  const SCENE_KEYS = Object.keys(SCENES);
  $('fScene').insertAdjacentHTML('beforeend', SCENE_KEYS.map(k => `<option value="${k}">${SCENES[k]}</option>`).join(''));
  function debugSettings(){
    if($('debug').hidden) return {};
    const f = $('fFlag').value, s = $('fScene').value, p = $('fPeka').value, a = $('fAim').value, k = $('fGeki').value;
    const cu = $('fCut').value, gs = $('fGisi').value;
    return {
      cut: cu === 'auto' ? null : cu,
      gisi: gs === 'auto' ? null : +gs,
      geki: k === 'auto' ? null : k,
      flag: f === 'auto' ? undefined : (f === 'none' ? null : f),
      scene: s === 'auto' ? null : s,
      peka: p === 'auto' ? null : p,
      aim: a === 'off' ? null : a
    };
  }

  function debugAT(type){
    if(state.phase === 'spinning') return;
    state.at = {type, goal:AT_GOAL[type], paid:0};
    setPeka(false); state.carry = null; screen.setAim(null);
    screen.setAT(state.at); screen.startAT(null); screen.resultAT(0);
    $('topper').classList.add('party');
    setMsg(`デバッグ：AT開始（${AT_GOAL[type]}枚まで）`); save(); updateUI();
  }
  $('atS7').addEventListener('click', () => debugAT('S7'));
  $('gekiPrev').addEventListener('click', () => { audio.init(); geki.start(); });
  $('cutPrev').addEventListener('click', () => { audio.init(); const c = $('fCut').value; const type = ['green','red','rainbow'].includes(c) ? c : 'rainbow'; screen.cutin(type); sfx.cutin(type); });
  $('atBAR').addEventListener('click', () => debugAT('BAR'));
  $('atEnd').addEventListener('click', () => { if(state.at && state.phase !== 'spinning'){ endAT(); save(); updateUI(); } });

  // リール配列表
  const mapCells = [[],[],[]];
  (function buildMap(){
    let html = '<thead><tr><th></th><th>左</th><th>中</th><th>右</th></tr></thead><tbody>';
    for(let k=0;k<N;k++){
      html += `<tr><td class="no">${N - k}</td>` + [0,1,2].map(i => `<td data-r="${i}" data-k="${k}"><div class="sym">${SYM[STRIPS[i][k]].html}</div></td>`).join('') + '</tr>';
    }
    $('reelmap').innerHTML = html + '</tbody>';
    $('reelmap').querySelectorAll('td[data-r]').forEach(td => mapCells[+td.dataset.r][+td.dataset.k] = td);
  })();
  function updateMap(){
    mapCells.flat().forEach(td => td.classList.remove('vis','mid'));
    if(state.phase === 'spinning') return;
    reels.forEach((r, i) => {
      const p = Math.round(r.p) % N;
      for(let k=0;k<3;k++){
        const td = mapCells[i][(p + k) % N];
        td.classList.add('vis'); if(k === 1) td.classList.add('mid');
      }
    });
  }

  // ================================================================
  // 11. 操作と初期化
  // ================================================================
  lever.addEventListener('click', pull);
  stopBtns.forEach(b => b.addEventListener('click', () => stopReel(+b.dataset.i)));
  $('reset').addEventListener('click', () => {
    if(state.phase === 'spinning') return;
    finishCount(); hideBigWin();
    if(state.at){ state.at = null; screen.setAT(null); $('topper').classList.remove('party'); }
    Object.assign(state, {credits:100, games:0, coinIn:0, coinOut:0, carry:null, payout:0, replay:false, flag:null, scene:null, postPeka:false, pekaType:'-'});
    reels.forEach(r => r.slide = null);
    setPeka(false); screen.idle(); screen.setAim(null);
    clearWins(); updateMap(); setMsg('リセットしました'); save(); updateUI();
  });
  const soundBtn = $('sound');
  const syncSound = () => soundBtn.textContent = state.sound ? '音：オン' : '音：オフ';
  soundBtn.addEventListener('click', () => { state.sound = !state.sound; store.set('slot.sound', state.sound); syncSound(); });
  const dbgBtn = $('dbgBtn');
  // GitHub Pages（*.github.io）では「内部を見る」を非表示。URLに ?debug を付けたときだけ表示する
  if(/\.github\.io$/.test(location.hostname) && !new URLSearchParams(location.search).has('debug')){
    dbgBtn.hidden = true; dbgBtn.style.display = 'none'; $('debug').hidden = true;
  }
  dbgBtn.addEventListener('click', () => {
    const show = $('debug').hidden;
    $('debug').hidden = !show;
    dbgBtn.setAttribute('aria-pressed', String(show));
    dbgBtn.textContent = show ? '内部を隠す' : '内部を見る';
  });
  document.addEventListener('keydown', e => {
    if(e.code === 'Space'){ e.preventDefault(); pull(); }
    else if(['1','2','3'].includes(e.key)) stopReel(+e.key - 1);
  });
  window.addEventListener('resize', measure);

  if(state.peka){ state.pekaType = '持ち越し'; setPeka(true); if(state.carry) screen.setAim(state.carry); }
  if(state.at){ screen.setAT(state.at); screen.startAT(null); screen.resultAT(0); $('topper').classList.add('party'); }
  syncSound(); screen.run(); measure(); updateMap();
  if(document.fonts) document.fonts.ready.then(measure);
  updateUI();

  const flags = [null, ...TABLE.map(t => t[0])];
  (function precompute(i){
    if(i >= flags.length){
      state.ready = true;
      setMsg(state.at ? 'AT中！ SPINで再開' : state.peka && state.carry ? `ランプ点灯中！ ${state.carry === 'S7' ? '777' : 'BAR・BAR・BAR'}を狙え！！` : 'SPINを押してスタート');
      updateUI(); return;
    }
    value([null,null,null], flags[i]);
    setTimeout(() => precompute(i + 1), 0);
  })(0);
})();
