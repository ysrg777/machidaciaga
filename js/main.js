
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
    CHEM:{html:'<span class="emo">🍒</span>',name:'中段チェリー'},
    RPL:{html:'<b class="rpl">REPLAY</b>',name:'リプレイ'}
  };
  const PAY = {S7:0, BAR:0, WML:10, BEL:14, GRP:8, CHE:2, CHEM:2, RPL:0}; // 1ラインあたりの配当（7・BARはAT突入）
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
    ['CHE',  1000], // 角チェリー（上段・下段）約1/66
    ['CHEM',  120], // 中段チェリー 約1/546
    ['BEL',    60], // 約1/1092
    ['WML',    60], // 約1/1092
    ['BAR',   218], // 約1/300
    ['S7',    164]  // 約1/400
  ];
  // 設定1〜6：7とBARの確率（65536分率）を変えて出玉率を調整。
  // 出玉率は「ランプ点灯後に7・BARを揃え、ATを消化した場合」のシミュレーション値（チャンスステージ込み）
  const SETTINGS = {
    1:{S7:27,   BAR:53,   rtp:80},
    2:{S7:73,   BAR:147,  rtp:90},
    3:{S7:167,  BAR:333,  rtp:105},
    4:{S7:300,  BAR:600,  rtp:120},
    5:{S7:783,  BAR:1567, rtp:150},
    6:{S7:3600, BAR:7200, rtp:200}
  };
  // 小役の「アツさ」：小役に当選したとき、さらに7・BARの抽選を行う（重複当選）
  const DUP = {RPL:.001, GRP:.005, WML:.05, BEL:.01, CHE:.10, CHEM:.50};
  // チャンスステージ移行：小役で7・BARの抽選に外れたときに抽選
  const CZIN = {RPL:.01, GRP:.01, WML:.10, BEL:.05, CHE:.30, CHEM:.30};
  // チャンスステージ：初回20G、終了時に50%で20G継続、合計100Gで強制終了。単独の7・BAR確率が4倍
  const CZ_GAMES = 20, CZ_CONT = .5, CZ_MAX = 100, CZ_MULT = 4, CZ_CAP = 30000;
  function czTable(){
    let S7 = TABLE.find(t => t[0] === 'S7')[1] * CZ_MULT, BAR = TABLE.find(t => t[0] === 'BAR')[1] * CZ_MULT;
    const tot = S7 + BAR; if(tot > CZ_CAP){ S7 *= CZ_CAP/tot; BAR *= CZ_CAP/tot; }
    return TABLE.map(([k,w]) => [k, k === 'S7' ? Math.round(S7) : k === 'BAR' ? Math.round(BAR) : w]);
  }
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
  // 回転速度（コマ/ms）。設定欄で切り替え可能
  const REEL_SPEEDS = {slow:{v:.011, name:'ゆっくり'}, normal:{v:.018, name:'ふつう'}, fast:{v:.027, name:'はやい'}};
  let SPEED = REEL_SPEEDS.normal.v;

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
      else if(s[0] === 'CHE') wins.push({key:line[0] === 1 ? 'CHEM' : 'CHE', line, cols:[0]}); // 中段なら中段チェリー
    });
    return wins;
  }

  // 当選していない役が成立してしまっているか（＝蹴飛ばし失敗）
  function violates(stops, flag){
    // チェリーは左リールだけで成立するので、左が止まった時点で判定
    // 角チェリーは上段・下段だけ、中段チェリーは中段だけに止めてよい
    if(stops[0] !== null) for(const line of LINES){
      if(symAt(0, stops[0], line[0]) !== 'CHE') continue;
      const ok = (flag === 'CHE' && line[0] !== 1) || (flag === 'CHEM' && line[0] === 1);
      if(!ok) return true;
    }
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
    CHE: {walk:55, meteor:20, meteorGold:4,  chestBlue:10, chestGreen:8,  chestRed:3},
    CHEM:{walk:25, meteor:15, meteorGold:12, chestBlue:6,  chestGreen:15, chestRed:20, hokuto:7},
    WML: {walk:30, meteor:15, meteorGold:10, chestBlue:8,  chestGreen:15, chestRed:15, hokuto:7},
    BIG: {walk:30, meteor:10, meteorGold:12, chestBlue:3,  chestGreen:8,  chestRed:15, chestRainbow:7, hokuto:15}
  };
  const isBig = f => f === 'BIG' || BIG.includes(f);
  const sceneRow = flag => SCENE_TABLE[isBig(flag) ? 'BIG' : String(flag)] || SCENE_TABLE.null;
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
    const res = {};
    for(const scn of Object.keys(SCENES)) res[scn] = expectOf(f => { const row = sceneRow(f); return (row[scn] || 0) / Object.values(row).reduce((a,b)=>a+b,0); });
    return res;
  };
  const PRE_PEKA = 0.25; // 先ペカの割合（残りは3つ目のSTOPで後ペカ）

  // 激アツ演出（全画面カットイン）の発生率。第2停止で発生
  const GEKI_RATE = {BIG:.40, CHEM:.02, WML:.01, BEL:.01, CHE:.004, other:.0003};

  // カットイン（リール回転開始時）：緑 < 赤 < 虹（虹は7・BAR確定）
  const CUTIN_TABLE = {
    BIG:  {green:.06, red:.35, rainbow:.15},
    CHEM: {green:.15, red:.10},
    WML:  {green:.12, red:.05},
    BEL:  {green:.12, red:.05},
    CHE:  {green:.06, red:.015},
    other:{green:.015, red:.0015}
  };
  const cutRow = f => CUTIN_TABLE[isBig(f) ? 'BIG' : (CUTIN_TABLE[f] ? f : 'other')];
  function pickCutin(f){
    let r = Math.random();
    for(const [k, p] of Object.entries(cutRow(f))){ if(r < p) return k; r -= p; }
    return null;
  }
  // 擬似連ステップアップ：何段目まで進むか（0＝なし）。⑤はメガポコナイト（激アツ）
  const GISI_TABLE = {
    BIG:  [.25, .12, .15, .16, .16, .16],
    CHEM: [.45, .20, .15, .10, .07, .03],
    WML:  [.55, .20, .12, .08, .04, .01],
    BEL:  [.55, .20, .12, .08, .04, .01],
    CHE:  [.72, .14, .08, .04, .02, 0],
    other:[.94, .045, .012, .0025, .0005, 0]
  };
  const gisiRow = f => GISI_TABLE[isBig(f) ? 'BIG' : (GISI_TABLE[f] ? f : 'other')];
  function pickGisi(f){
    let r = Math.random();
    const row = gisiRow(f);
    for(let n=0;n<row.length;n++){ if(r < row[n]) return n; r -= row[n]; }
    return 0;
  }
  // 演出ごとの7・BAR期待度（今の設定の確率から計算）
  // 重複当選も含めた「演出に使う当選状況」の分布（'BIG'＝7・BAR当選）
  function effDist(){
    const out = []; let rest = 1;
    TABLE.forEach(([k,w]) => { const p = w/65536; rest -= p;
      if(DUP[k]){ out.push(['BIG', p*DUP[k]]); out.push([k, p*(1 - DUP[k])]); } else out.push([k, p]); });
    out.push([null, rest]);
    return out;
  }
  function expectOf(rateFn){
    let all = 0, big = 0;
    effDist().forEach(([k,p]) => { const r = rateFn(k); all += p*r; if(isBig(k)) big += p*r; });
    return all ? big/all : 0;
  }
  const GISI_START = 500, GISI_GAP = 1200, GISI_FREEZE = 420;
  const CUT_DUR = 1500;   // カットインの表示時間
  const GISI5_HOLD = 2000;  // ⑤追いメガポコナイトを液晶で見せる時間。その後に全画面の激アツ
  const GEKI_DUR = 5000;   // 全画面の激アツは5秒表示（タップで早送り可）
  const gekiRate = f => isBig(f) ? GEKI_RATE.BIG : (GEKI_RATE[f] ?? GEKI_RATE.other);
  const calcGekiExpect = () => expectOf(gekiRate);

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
        // 効果音・BGMの音源を読み込んでおく（assets/sound）
        const load = (url, key) => fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))
          .then(b => { this[key] = b; }).catch(() => {});
        load('assets/sound/ooi.mp3?ver=202610040157', 'ooiBuf');
        load('assets/sound/aishiteru.mp3?ver=202610040157', 'aiBuf');
        load('assets/sound/pokyun.mp3?ver=202610040157', 'pokyunBuf');
        load('assets/sound/bigwin.mp3?ver=202610040157', 'bigwinBuf');
        load('assets/sound/seven_stop.mp3?ver=202610040157', 'sevenStopBuf');
        load('assets/sound/seven_align.mp3?ver=202610040157', 'sevenAlignBuf');
        load('assets/sound/bonusin_snd.mp3?ver=202610040157', 'bonusinBuf');
        setTimeout(() => load('assets/sound/bonus_bgm.mp3?ver=202610040157', 'bonusBuf'), 300);
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
    // キャラの動き用の拍。音声の時計（一時停止すると止まる）ではなく画面の時計で数える
    beat(){ return performance.now()/1000 * BPM / 60; }
  };

  // ボーナスゲーム中のBGM：ループ再生、フェードイン／アウト
  const bonusBgm = {
    src:null, gain:null,
    get playing(){ return !!this.src; },
    start(){
      if(this.src || !audio.ctx || !audio.bonusBuf) return;
      const c = audio.ctx, t = c.currentTime;
      const src = c.createBufferSource(), g = c.createGain();
      src.buffer = audio.bonusBuf; src.loop = true;
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.8, t + 1.2);
      src.connect(g); g.connect(audio.master); src.start();
      this.src = src; this.gain = g;
    },
    stop(){
      if(!this.src) return;
      const c = audio.ctx, t = c.currentTime, src = this.src, g = this.gain;
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(g.gain.value, .0001), t); g.gain.exponentialRampToValueAtTime(.0001, t + .8);
      src.stop(t + .85);
      this.src = null; this.gain = null;
    }
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
    // （ボーナスBGMの再生は bonusBgm を参照）
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
    stage(){ audio.noise(0,.35,.25,2500,'bandpass'); audio.tone(300,0,.35,{type:'sine',vol:.08,to:1200}); },
    czJudge(){ [392,392,523].forEach((f,k)=>audio.tone(f,k*.15,.12,{type:'square',vol:.06})); },
    czWeak(){ audio.tone(220,0,.3,{type:'triangle',vol:.08}); audio.tone(262,.15,.3,{type:'triangle',vol:.06}); },
    czStrong(){ audio.noise(0,.2,.3,800); [523,659,784,1047].forEach((f,k)=>audio.tone(f,.05 + k*.06,.2,{type:'square',vol:.07})); },
    czCont(){ [523,659,784,1047,1319,1568,2093].forEach((f,k)=>audio.tone(f,k*.07,.25,{type:'triangle',vol:.1})); [0,.15,.3].forEach(a=>audio.noise(.5 + a,.3,.15,1800)); },
    notify(){ audio.tone(1568,0,.12,{type:'sine',vol:.07}); audio.tone(2093,.1,.18,{type:'sine',vol:.07}); },
    battleStart(){ audio.noise(0,.6,.5,180); audio.tone(98,0,.9,{type:'sawtooth',vol:.18,to:60}); [392,523,659].forEach((f,k)=>audio.tone(f,.35 + k*.12,.3,{type:'square',vol:.07})); },
    battleHit(who){ audio.noise(0,.12,.25,3000,'highpass'); audio.noise(.28,.12,.5,500); audio.tone(who === 'hero' ? 330 : 180,.28,.18,{type:'square',vol:.12,to:80}); },
    battleFinal(){ for(let k=0;k<16;k++) audio.noise(k*.06,.05,.12 + k*.015,700); },
    battleClash(){ audio.noise(0,.7,.7,300); audio.tone(140,0,.7,{type:'sawtooth',vol:.2,to:40}); },
    battleWin(){ [523,659,784,1047,1319].forEach((f,k)=>audio.tone(f,k*.09,.3,{type:'square',vol:.08})); },
    battleComeback(){ audio.tone(220,0,.5,{type:'sawtooth',vol:.08,to:110}); [523,659,784,1047,1319,1568,2093].forEach((f,k)=>audio.tone(f,1.1 + k*.07,.3,{type:'triangle',vol:.1})); },
    battleLose(){ [392,330,262,196].forEach((f,k)=>audio.tone(f,k*.18,.35,{type:'triangle',vol:.09})); },
    // 次回予告のジングル（書き換え・放送事故のときは追加の音）
    preview(pv){
      [784,988,1175,1568].forEach((f,k)=>audio.tone(f,.05 + k*.08,.18,{type:'square',vol:.06}));
      audio.tone(2093,.42,.25,{type:'sine',vol:.06});
      if(pv.kind === 'rewrite'){ audio.noise(1.2,.15,.3,2000); setTimeout(() => { audio.noise(0,.2,.6,300); audio.tone(110,0,.3,{type:'square',vol:.15,to:60}); }, 1700); }
      if(pv.kind === 'accident'){ audio.noise(0,1.2,.25,4000,'highpass'); setTimeout(() => sfx.kyuin777(), 1300); }
      if(pv.color >= 3) [1568,2093,2637].forEach((f,k)=>audio.tone(f,.6 + k*.07,.2,{type:'triangle',vol:.06}));
    },
    reveal(){ audio.noise(0,.15,.4,3000,'highpass'); [523,784,1047].forEach((f,k)=>audio.tone(f,.05 + k*.06,.2,{type:'square',vol:.07})); },
    // フリーズ：ガタガタ・暗転・サイレン
    freezeRattle(){ for(let k=0;k<14;k++) audio.noise(k*.055, .04, .35, 1200 + (k%3)*600); audio.tone(70,0,.8,{type:'square',vol:.08,to:50}); },
    freezeBlack(){ audio.tone(90,0,.5,{type:'sine',vol:.25,to:30}); audio.noise(0,.08,.5,800); },
    siren(on){
      if(sfx._siren){ try{ sfx._siren.o.stop(); }catch(e){} sfx._siren = null; }
      if(!on || !state.sound || !audio.ctx) return;
      const c = audio.ctx, o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), g = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = 760; lfo.frequency.value = 1.6; lg.gain.value = 180;
      lfo.connect(lg); lg.connect(o.frequency); g.gain.value = .05; o.connect(g); g.connect(audio.master);
      o.start(); lfo.start(); sfx._siren = {o};
      o.onended = () => { try{ lfo.stop(); }catch(e){} };
    },
    kyuinSynth(){
      for(let k=0;k<4;k++){ const at = k*.18; audio.tone(600, at, .24, {type:'sine', vol:.18, to:3200, vib:60}); audio.tone(1200, at + .02, .2, {type:'square', vol:.03, to:5200}); }
      [2637,3136,3520,4186].forEach((f,k)=>audio.tone(f, .78 + k*.06, .2, {type:'sine', vol:.06}));
    },
    freezeRumble(){ audio.tone(55,0,3,{type:'sawtooth',vol:.12,to:40}); audio.noise(0,3,.1,200); },
    freezeHit(){ audio.tone(3136,0,.6,{type:'sine',vol:.14}); audio.tone(4186,.05,.5,{type:'sine',vol:.1}); audio.noise(0,.2,.4,6000,'highpass'); },
    srStart(){ [392,523,659,784].forEach((f,k)=>audio.tone(f,k*.07,.25,{type:'square',vol:.08})); audio.noise(0,.3,.25,2000); },
    srReveal(){ audio.noise(0,.2,.4,3000,'highpass'); [659,880,1175,1568].forEach((f,k)=>audio.tone(f,.05 + k*.07,.22,{type:'triangle',vol:.1})); },
    uwanose(){ [784,1047,1319,1568,2093].forEach((f,k)=>audio.tone(f,k*.05,.18,{type:'square',vol:.07})); audio.noise(0,.2,.25,3000,'highpass'); },
    zoneIn(){ audio.tone(110,0,.8,{type:'sawtooth',vol:.12,to:440}); [523,659,784,1047].forEach((f,k)=>audio.tone(f,.6 + k*.08,.3,{type:'square',vol:.08})); },
    staff(){ [880,1175,1568].forEach((f,k)=>audio.tone(f,k*.1,.16,{type:'sine',vol:.08})); },
    czIn(){ [523,659,784,988,1175,1568].forEach((f,k)=>audio.tone(f,k*.07,.22,{type:'square',vol:.07})); audio.noise(0,.3,.2,3000,'highpass'); },
    czEnd(){ [784,659,523,392].forEach((f,k)=>audio.tone(f,k*.12,.25,{type:'triangle',vol:.08})); },
    // 777確定：「キュインキュイン！」（ビブラートのかかった上昇音を4回）＋きらめき
    // 音源の再生（同じ種類は前の音を止めてから鳴らす）
    playBuf(name, vol = 1){
      const buf = audio[name + 'Buf'];
      if(!state.sound || !audio.ctx || !buf) return false;
      sfx.stopBuf(name);
      const src = audio.ctx.createBufferSource(), g = audio.ctx.createGain();
      src.buffer = buf; g.gain.value = vol; src.connect(g); g.connect(audio.master); src.start();
      (audio.playing ||= {})[name] = src;
      return true;
    },
    stopBuf(name){ const p = audio.playing && audio.playing[name]; if(p){ try{ p.stop(); }catch(e){} audio.playing[name] = null; } },
    // BIG WIN!! の効果音（音源を鳴らせたら true）
    bigwinSound(){
      if(!state.sound || !audio.ctx || !audio.bigwinBuf) return false;
      const src = audio.ctx.createBufferSource(), g = audio.ctx.createGain();
      src.buffer = audio.bigwinBuf; g.gain.value = 1.0;
      src.connect(g); g.connect(audio.master); src.start();
      sfx.stopBuf('bigwin'); (audio.playing ||= {}).bigwin = src;
      state.bigwinSndAt = performance.now();
      return true;
    },
    kyuin777(){
      if(state.sound && audio.ctx && audio.pokyunBuf){
        const src = audio.ctx.createBufferSource(), g = audio.ctx.createGain();
        src.buffer = audio.pokyunBuf; g.gain.value = 1.1;
        src.connect(g); g.connect(audio.master); src.start();
        return;
      }
      for(let k=0;k<4;k++){
        const at = k*.2;
        audio.tone(600, at, .26, {type:'sine', vol:.16, to:3000, vib:60});
        audio.tone(1200, at + .02, .22, {type:'square', vol:.03, to:5200});
      }
      [2637,3136,3520,4186].forEach((f,k)=>audio.tone(f, .85 + k*.06, .2, {type:'sine', vol:.06}));
      [784,988,1175,1568].forEach(f=>audio.tone(f, .9, 1.2, {type:'triangle', vol:.07}));
    },
    cracker(){ audio.noise(0,.08,.6,5000,'highpass'); audio.noise(.02,.25,.25,1800); },
    // 大当たり確定：流れ星のきらめき → 上昇音 → 和音
    kakutei(){
      [3136,2637,2349,2093,1760].forEach((f,k)=>audio.tone(f,k*.05,.15,{type:'sine',vol:.06}));
      audio.tone(300,.45,.5,{type:'sawtooth',vol:.06,to:1800});
      [784,988,1175,1568].forEach(f=>audio.tone(f,.85,.9,{type:'triangle',vol:.07}));
      audio.noise(.85,.3,.2,3000,'highpass');
    },
    // ボーナス突入：ドラムロール → 幕が開いてファンファーレ
    bonusIn(){
      for(let k=0;k<14;k++) audio.noise(k*.045, .05, .18 + k*.012, 900);
      [523,659,784,1047].forEach((f,k)=>{ audio.tone(f,.68 + k*.09,.28,{type:'square',vol:.08}); audio.tone(f*2,.68 + k*.09,.28,{type:'triangle',vol:.05}); });
      [1047,1319,1568,2093].forEach(f=>audio.tone(f,1.1,1.1,{type:'triangle',vol:.06}));
      [0,.12,.24,.36].forEach(a=>audio.tone(2637,1.3 + a,.12,{type:'sine',vol:.05}));
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
    cz: saved ? saved.cz || null : null, czGame: false,
    battle: saved && saved.battle && saved.battle.type ? saved.battle : null, battleGame: false,
    sr: null, srBattle: saved ? saved.srBattle || null : null, srGame: false, srPending: false,
    zencho: saved ? saved.zencho || null : null, czStock: saved ? saved.czStock || null : null, stock: saved ? saved.stock || [] : [],
    hiki: saved ? saved.hiki || 0 : 0, sinceBig: saved ? saved.sinceBig || 0 : 0, bigs: saved ? saved.bigs || 0 : 0,
    hist: saved ? saved.hist || [] : [], diffLog: saved ? saved.diffLog || [] : [],
    stage: saved ? saved.stage || 1 : 1, dupBig: null,
    stageCount: saved ? saved.stageCount || 0 : 0, stageLimit: saved ? saved.stageLimit || 0 : 0,
    at: saved ? saved.at || null : null, navi: null, ctrlFlag: null,
    payout: 0, replay: false, flag: null, ready: false, scene: null, tenpai: false, geki: false,
    missCount: 0, aimGame: false, assist: false,
    cutin: null, gisi: 0, gisiDone: 0, gisiDelay: 0, lockUntil: 0, skipQueued: false, ooi: false,
    peka: saved ? !!saved.carry : false, postPeka: false, pekaType: '-',
    phase: 'idle', startTs: 0, lastTs: 0,
    sound: store.get('slot.sound', true),
    bgm: store.get('slot.bgm', true),
    setting: store.get('slot.setting', 6),   // 初期値は設定6
    reelSpeed: store.get('slot.reelSpeed', 'normal'),
    name: store.get('slot.name', ''), over1000: store.get('slot.over1000', false)
  };
  applySetting(state.setting); calcExpect();
  const save = () => store.set('slot4.state', {credits:state.credits, games:state.games,
    coinIn:state.coinIn, coinOut:state.coinOut, carry:state.carry, at:state.at, cz:state.cz, battle:state.battle, sr:state.sr, srBattle:state.srBattle, zencho:state.zencho, czStock:state.czStock, stock:state.stock,
    hiki:state.hiki, sinceBig:state.sinceBig, bigs:state.bigs, hist:state.hist, diffLog:state.diffLog, stage:state.stage, stageCount:state.stageCount, stageLimit:state.stageLimit});

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
    ['ぶどう ×3', '8枚'], ['角チェリー（左リール上段・下段）', '2枚'], ['中段チェリー', '2枚'], ['リプレイ ×3', '再遊技']
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
  // リスナーとそれぞれの定番コメント（指定のアセット）。No.33〜40はハズレたときなどに出る辛口コメント
  const LISTENERS = [
    ['つばさ','こんにちは〜'],
    ['みかん','今日もきたよ'],
    ['たけし','お疲れさま〜'],
    ['ゆうき','めっちゃ笑ったw'],
    ['さくら','今日もかわいい'],
    ['ケン','何の話してる？'],
    ['あや','初見です！'],
    ['しん','まだやってたw'],
    ['まい','ご飯食べてくる'],
    ['りょう','声でかいwww'],
    ['なな','それは草'],
    ['たろ','今日人多いね'],
    ['ミホ','おかえり〜'],
    ['こうじ','仕事終わった！'],
    ['みゆ','癒されにきた'],
    ['ゆう','その話好きw'],
    ['あき','それ本当？'],
    ['なお','また寝不足？'],
    ['まさ','眠くなってきた'],
    ['りな','こんばんは〜'],
    ['けい','その服似合うね'],
    ['しお','今日も元気ね'],
    ['ひろ','何時まで配信？'],
    ['もも','コメント読んでw'],
    ['だい','それは無理あるw'],
    ['ちか','また食べてるw'],
    ['ゴウ','その話長いw'],
    ['ゆき','え、今の何？'],
    ['まこ','初見だけど面白い'],
    ['れん','今日は静かだね'],
    ['あい','それ好きだわ'],
    ['ジョー','もっと喋って！'],
    ['さと','そのノリ苦手…'],
    ['カズ','今日は微妙かも'],
    ['りく','なんかつまらん'],
    ['ゆうた','前の方が良かった'],
    ['あきら','今日は見ないかな'],
    ['マナ','ちょっと無理かも'],
    ['しゅん','うるさすぎるw'],
    ['レオ','その話もういいw'],
    ['のぞ','それ言っちゃう？'],
    ['コウ','また同じ話だw'],
    ['エリ','それ言いすぎw'],
    ['たく','なんだこの配信w'],
    ['まる','ずっと見てるよ'],
    ['ハル','今日も来れた！'],
    ['ゆめ','そろそろ寝ます'],
    ['ソラ','また明日くるね'],
    ['町田23位','え？なに？どしたぁ？'],
    ['やすらぎ','朝までいく？']
  ].map(([name, text], i) => ({name, text, av:["🐰", "🐻", "🐱", "🐶", "🐼", "🦊", "🐹", "🐧", "🐨", "🐸", "🐯", "🐮", "🐷", "🐵", "🐥", "🦁"][i % 16], salty: i >= 32 && i <= 39}));
  const VIEWERS = LISTENERS.map(l => [l.av, l.name]);
  const CALM_LISTENERS = LISTENERS.filter(l => !l.salty), SALTY_LISTENERS = LISTENERS.filter(l => l.salty);
  // ボーナス中（ライブ配信中）のコメント
  const LIVE_TALK = ['うおおおお！', '最高！！', 'フゥーーー！', 'アンコール！', 'コール入れて！', '声出していこう！', '会場の一体感やばい',
    '鳥肌たった', '泣ける…', '神曲きた', 'セトリ神すぎ', '照明きれい', '初ライブ参戦！', '前列とれた！', 'ペンライト振ってる',
    'まだまだいける！', 'あと何枚？', '上乗せこい！', 'ありがとう〜！', 'この瞬間のために生きてる', '推しが尊い', '跳べーーー！'];
  const LIVE_TALK_777 = ['町田さーーん！', 'ギター痺れる', '生歌すご', '覚醒町田さん最強', 'M！A！C！H！I！D！A！', 'Machida Universe最高！', '炎の演出アツい'];
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
  HERO.src = 'assets/img/haishin.webp?ver=202610040157';

  // ボーナス（AT）中のキャラクター（2枚目の添付画像）
  const HEROINE = new Image();
  HEROINE.src = 'assets/img/bonus.webp?ver=202610040157';

  // 擬似連で登場するおじいちゃん（添付画像）
  const OJII = new Image();
  OJII.src = 'assets/img/ojii.webp?ver=202610040157';
  // 激アツ全画面演出のキャラクター
  const TUX = new Image();
  TUX.src = 'assets/img/gekiatsu.webp?ver=202610040157';

  // チャンスステージの背景（東京の夜景）とキャラクター（16ポーズのスプライト。1マス200px、4×4）
  const CZ_BG = new Image();
  CZ_BG.src = 'assets/img/chance_bg.webp?ver=202610040157';
  const CZ_SPRITES = new Image();
  CZ_SPRITES.src = 'assets/img/chance_chara.webp?ver=202610040157';

  // 通常ステージのキャラ：ポーズ集A（ステージ1・2）とB（ステージ3）。1マス200px、4×4
  const ST_A = new Image();
  ST_A.src = 'assets/img/stage12_chara.webp?ver=202610040157';
  // バトルの相手：1行目 黒服（拳銃）、2行目 MCギフト（各6ポーズ：待機・攻撃・ダメージ・ピンチ・敗北・勝ち誇り）、
  // 3行目 S6ライバー6人（通常）、4行目 同（KO）
  const ENEMY_SPRITES = new Image();
  ENEMY_SPRITES.src = 'assets/img/battle_chara.webp?ver=202610040157';
  // 777ボーナス（7揃いのAT）のステージ：背景「Machida Universe」と覚醒町田さん（5×5＝25ポーズ）
  const UNIV_BG = new Image();
  UNIV_BG.src = 'assets/img/bonus777_bg.webp?ver=202610040157';
  const MACHIDA = new Image();
  MACHIDA.src = 'assets/img/bonus777_chara.webp?ver=202610040157';
  // 777ボーナス中の液晶背景：ループ動画（640×320・約40秒・無音。曲はボーナスBGMのまま）
  const ATV = document.createElement('video');
  ATV.muted = true; ATV.loop = true; ATV.playsInline = true; ATV.setAttribute('playsinline', ''); ATV.setAttribute('muted', ''); ATV.preload = 'auto';
  const ATV_MP4 = 'assets/video/bonus777.mp4?ver=202610040157';
  const ATV_WEBM = 'assets/video/bonus777.webm?ver=202610040157';
  const ATV_HD = 'assets/video/bonus777_hd.mp4?ver=202610040157';   // 高画質版（公開版のみ assets/video/bonus777_hd.mp4）
  const atvReady = () => ATV.readyState >= 2 && ATV.videoWidth > 0;
  // ボーナス図柄が揃ったあとの全画面演出（縦長の動画・約8秒）。音声は別の音源で動画と同時に鳴らす
  const BV = document.createElement('video');
  BV.muted = true; BV.playsInline = true; BV.setAttribute('playsinline', ''); BV.setAttribute('muted', ''); BV.preload = 'auto';
  const BV_MP4 = 'assets/video/bonusin.mp4?ver=202610040157';
  const BV_WEBM = 'assets/video/bonusin.webm?ver=202610040157';   // 公開版では assets/video/bonusin.webm（H.264が使えないブラウザ用）
  const BV_HD = 'assets/video/bonusin_hd.mp4?ver=202610040157';    // 高画質版（公開版のみ assets/video/bonusin_hd.mp4）
  // 動画の画質：標準／高画質（設定欄で切り替え）。H.264が使えないブラウザはWebM（標準画質）
  const videoQ = () => { try { return JSON.parse(localStorage.getItem('slot.vq')) || 'sd'; } catch(e){ return 'sd'; } };
  const canMp4 = BV.canPlayType('video/mp4; codecs="avc1.4D401E"') !== '';
  function applyVideoQuality(){
    const hd = videoQ() === 'hd' && canMp4;
    const atv = hd && ATV_HD ? ATV_HD : (canMp4 || !ATV_WEBM ? ATV_MP4 : ATV_WEBM);
    const bv  = hd && BV_HD  ? BV_HD  : (canMp4 || !BV_WEBM  ? BV_MP4  : BV_WEBM);
    const wasPlaying = !ATV.paused;
    if(ATV.getAttribute('src') !== atv){ ATV.src = atv; if(wasPlaying) ATV.play().catch(() => {}); }
    if(BV.getAttribute('src') !== bv) BV.src = bv;
  }
  applyVideoQuality();
  const bvReady = () => BV.readyState >= 2 && BV.videoWidth > 0;
  // 777確定の全画面演出に使うイラスト（縦長）
  const K777 = new Image();
  K777.src = 'assets/img/kakutei777.webp?ver=202610040157';
  // 実家ステージ（ステージ4）の背景
  const JIKKA_BG = new Image();
  JIKKA_BG.src = 'assets/img/stage4_bg.webp?ver=202610040157';
  const ST_B = new Image();
  ST_B.src = 'assets/img/stage3_chara.webp?ver=202610040157';

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
      aim:null, cut:null, cutT:-1e9, gisi:0, gisiT:-1e9, gisiFx:[], ooiT:-1e9,
      cz:null, czT:-1e9, czEndT:-1e9, pose:0, poseT:0,
      stg:1, stageT:-1e9, np:null, npCat:'', npT:0, pfx:[], kiaiT:-1e9,
      czAori:'weak', czAoriT:-1e9, czAoriSeed:0, czResT:-1e9, czResOk:false, lucky:false, players:null, bq:[], bcur:null, bT:0,
      bt:null, bAct:null, bhpView:[100,100], pv:null, pvT:0, rv:null, rvT:-1e9, pvRevealed:false,
      sr:null, srT:0, srRes:null, srResT:0, pickT:0,
      zen:null, zenT:0, hiki:0, atAddV:0, atAddT:-1e9, zoneT:-1e9, bBanner:null, bBannerT:-1e9};

    function resize(){
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.getBoundingClientRect().width;
      if(!w) return;
      const cw = Math.round(w * dpr), ch = Math.round(w / 2 * dpr);
      if(cw === cv.width && ch === cv.height) return;
      cv.width = cw; cv.height = ch;
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
    function drawUI(t, noComments = false){
      g.save();
      g.fillStyle = '#FF2D55'; rrPath(g, 6, 6, 30, 13, 4); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 8.5px sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center';
      g.fillText('LIVE', 21, 13);
      g.fillStyle = 'rgba(0,0,0,.45)'; rrPath(g, 40, 6, 52, 13, 4); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = '8.5px sans-serif';
      if(S.lucky){
        const rg = g.createLinearGradient(44, 0, 92, 0), o = (t/5) % 360;
        for(let k=0;k<=5;k++) rg.addColorStop(k/5, `hsl(${(o + k*60) % 360},100%,62%)`);
        g.save(); g.font = 'bold 9.5px sans-serif'; g.fillStyle = '#fff'; g.fillText('👁', 44, 13);
        g.shadowColor = `hsl(${o},100%,60%)`; g.shadowBlur = 6; g.fillStyle = rg; g.fillText('7777', 57, 13); g.restore();
      } else if(S.players !== null){
        // 実際にプレイ中の人数（Firebaseで集計）
        g.fillStyle = '#5DFF8A'; g.beginPath(); g.arc(47, 12.5, 2.4, 0, 6.283); g.fill();
        g.fillStyle = '#fff'; g.fillText(`${S.players}人プレイ中`, 52, 13);
      } else g.fillText('👁 ' + Math.floor(S.viewers).toLocaleString(), 44, 13);
      g.fillStyle = 'rgba(0,0,0,.45)'; rrPath(g, W - 64, 6, 58, 13, 4); g.fill();
      g.fillStyle = '#fff'; g.fillText('❤ ' + (S.likes >= 10000 ? (S.likes/10000).toFixed(1) + '万' : S.likes), W - 58, 13);
      // コメント欄（左下）
      const now = performance.now();
      if(!noComments) S.comments.forEach((m, i) => {
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
        g.font = `${size*.8}px sans-serif`; g.fillText({WML:'🍉', CHE:'🍒', CHEM:'🍒', BEL:'🔔', GRP:'🍇'}[key] || '', x, y);
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
      if(openAmt > 0 && S.result && (S.result.flag || S.result.bigKey)){
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
        if(S.result && (S.result.bigKey || S.result.flag)) drawSymbol(S.result.bigKey || S.result.flag, x, y - 18 - rise*22, 26);
        else {
          g.fillStyle = `rgba(190,190,200,${.6*(1-rise*.6)})`;
          [[-7,0],[4,-5],[9,4]].forEach(([dx,dy]) => { g.beginPath(); g.arc(x+dx, y-16-rise*16+dy, 7+rise*4, 0, 6.283); g.fill(); });
        }
      }
    }

    // --- 予告：ランキング急上昇 ---
    function drawRank(t){
      const res = S.mode === 'result' ? S.result : null;
      const success = res && res.big;
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
    // 「BIG WIN!!」：虹色の極太・斜体（パチスロ風）
    function drawBigWin(t){
      g.save(); g.translate(W/2, 60); g.scale(1 + .05*Math.sin(t/110), 1 + .05*Math.sin(t/110)); g.transform(1, 0, -.18, 1, 0, 0);
      g.font = '38px "Titan One", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.lineWidth = 10; g.strokeStyle = '#2a0010'; g.strokeText('BIG WIN!!', 0, 0);
      g.lineWidth = 6; g.strokeStyle = '#fff'; g.strokeText('BIG WIN!!', 0, 0);
      const gr = g.createLinearGradient(-130, 0, 130, 0), o = (t/4) % 360;
      for(let k=0;k<=6;k++) gr.addColorStop(k/6, `hsl(${(o + k*55) % 360},100%,58%)`);
      g.shadowColor = '#FFD23A'; g.shadowBlur = 14; g.fillStyle = gr; g.fillText('BIG WIN!!', 0, 0);
      g.restore();
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
      const pulse = 1 + .04*Math.sin(t/120);
      g.save(); g.translate(W/2, 50); g.scale(pulse*.96, pulse*.96);  // 上の視聴者数（7777）にかからない位置
      g.fillStyle = 'rgba(20,0,10,.85)'; g.strokeStyle = blink ? '#FFE14D' : '#FF2D55'; g.lineWidth = 3;
      g.shadowColor = blink ? '#FFE14D' : '#FF2D55'; g.shadowBlur = 14;
      rrPath(g, -146, -28, 292, 56, 12); g.fill(); g.shadowBlur = 0; g.stroke();
      if(key === 'S7') for(let k=0;k<3;k++) draw7(g, -114 + k*34, 1, 42);
      else for(let k=0;k<3;k++){
        const x = -134 + k*38;
        g.fillStyle = '#161616'; g.fillRect(x, -13, 34, 26); g.strokeStyle = '#F2C14E'; g.lineWidth = 2; g.strokeRect(x, -13, 34, 26);
        g.fillStyle = '#F2C14E'; g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BAR', x + 17, 1);
      }
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = '900 25px "M PLUS 1p", sans-serif'; g.lineJoin = 'round';
      g.lineWidth = 5; g.strokeStyle = '#000'; g.strokeText('を狙え！！', -12, 2);
      g.fillStyle = blink ? '#FFE14D' : '#fff'; g.fillText('を狙え！！', -12, 2);
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
      if(step > 0 && S.mode === 'spin' && !S.bt){
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
      const fe = t - (S.gfT || -1e9);
      if(fe >= 0 && fe < 1400){
        g.save(); g.globalAlpha = Math.min(1, (1400 - fe)/300); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = '900 18px "M PLUS 1p", sans-serif'; g.lineJoin = 'round'; g.lineWidth = 5; g.strokeStyle = '#fff';
        g.strokeText('発展ならず…', W/2, 78); g.fillStyle = '#5a6aaa'; g.fillText('発展ならず…', W/2, 78); g.restore();
      }
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

    // ================================================================
    // 通常ステージ（1〜3）：背景とキャラのポーズ・ポーズごとの演出
    // ================================================================
    // ステージごとに使うポーズ（スプライトの番号 0〜15）
    const STAGE_POSES = {
      1:{sheet:'A', idle:[0,1,3,13], hype:[1,3], happy:[2,9,13], sad:[10], love:[11]},
      2:{sheet:'A', idle:[5,7,8,12,6], hype:[4,14], happy:[15,6], sad:[7,12], love:[15]},
      3:{sheet:'B', idle:[0,4,6,8,9,13], hype:[5,15,1], happy:[2,3,12,10], sad:[8,7], love:[11,14]},
      4:{sheet:'A', idle:[0,1,3,5,7,8,13,6], hype:[4,14,9], happy:[2,9,13,15,6], sad:[10,12], love:[11]}   // 実家もコウジ（ポーズ集Aを全部使う）
    };
    // ポーズごとの演出の種類
    const POSE_FX = {
      A:['chill','sparkle','hearts','glint','fire','game','drink','sway','notes','impact','tears','hearts','zzz','sparkle','speed','confetti'],
      B:['sparkle','impact','hearts','notes','glint','fire','drink','tears','question','game','drink','hearts','impact','sparkle','bow','kiai']
    };
    const FX_TALK = {
      fire:['燃えてる🔥','アツい！'], game:['何のゲーム？','うまいw'], drink:['いい飲みっぷり','グビッw'], zzz:['寝てるw','起きて〜'],
      notes:['ノリノリ♪','いい曲'], tears:['泣いてるw','笑いすぎ'], speed:['速っ','どこ行くのw'], confetti:['推せる！','ペンライト振る！'],
      glint:['グラサン似合う','かっけぇ'], question:['どうした？','悩んでる？'], bow:['こちらこそ！','よろしく〜'], kiai:['気合い！','うおお！'],
      hearts:['かわいい','好き'], impact:['いけー！','きたー！']
    };
    const sheetImg = s => s === 'A' ? ST_A : ST_B;
    // スプライトの各マスで、実際に絵がある範囲（透明部分を除いた範囲）を一度だけ測る。
    // ポーズによって余白が違うため、マスごと拡大すると切り替えのたびに大きさが変わって見えていた
    const boxCache = new Map();
    function spriteBox(img, idx){
      let boxes = boxCache.get(img);
      if(!boxes){
        const G = img === MACHIDA ? 5 : 4;   // 覚醒町田さんだけ 5×5
        const W0 = img.naturalWidth, cell = W0 / G, cv2 = document.createElement('canvas');
        cv2.width = W0; cv2.height = img.naturalHeight;
        const c2 = cv2.getContext('2d'); c2.drawImage(img, 0, 0);
        let data = null;
        try { data = c2.getImageData(0, 0, W0, img.naturalHeight).data; } catch(e){ /* ローカルで直接開いた場合など：枠そのままで描く */ }
        boxes = [];
        if(!data){ for(let k=0;k<G*G;k++) boxes.push({x:(k % G)*cell, y:Math.floor(k / G)*cell, w:cell, h:cell}); boxCache.set(img, boxes); return boxes[idx]; }
        for(let k=0;k<G*G;k++){
          const ox = (k % G)*cell, oy = Math.floor(k / G)*cell;
          let x0 = cell, y0 = cell, x1 = 0, y1 = 0;
          for(let y=0;y<cell;y+=2) for(let x=0;x<cell;x+=2){
            if(data[((oy + y)*W0 + ox + x)*4 + 3] > 40){ if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; }
          }
          boxes.push(x1 > x0 ? {x:ox + x0, y:oy + y0, w:x1 - x0 + 2, h:y1 - y0 + 2} : {x:ox, y:oy, w:cell, h:cell});
        }
        boxCache.set(img, boxes);
      }
      return boxes[idx];
    }
    // 絵の高さを targetH にそろえて描く（横に長いポーズは maxW に収まるよう縮める）
    function spriteSize(img, idx, targetH, maxW){
      const b = spriteBox(img, idx), sc = Math.min(targetH / b.h, maxW / b.w);
      return {b, sc, w:b.w*sc, h:b.h*sc};
    }
    function choosePose(cat, t){
      const set = STAGE_POSES[S.stg], list = set[cat] || set.idle;
      let p; do { p = pick(list); } while(list.length > 1 && p === S.np);
      S.np = p; S.npCat = cat; S.npT = t;
      const tag = POSE_FX[set.sheet][p];
      if(FX_TALK[tag] && Math.random() < .35) comment(pick(FX_TALK[tag]));
      if(tag === 'kiai') S.kiaiT = t;
    }
    function moodToCat(mood){
      return mood === 'happy' || mood === 'jump' ? 'happy' : mood === 'sad' ? 'sad' : (mood === 'look' || mood === 'shock') ? 'hype' : 'idle';
    }

    // ステージ2：ゲーム部屋（夜）
    function drawGameRoom(t){
      const wall = g.createLinearGradient(0,0,0,H); wall.addColorStop(0,'#120e2e'); wall.addColorStop(1,'#2a1650');
      g.fillStyle = wall; g.fillRect(0,0,W,H);
      // 天井のLEDテープ（色が流れる）
      for(let x=0;x<W;x+=4){ g.fillStyle = `hsl(${(x*1.2 + t/12) % 360},90%,60%)`; g.fillRect(x, 20, 4, 2); }
      g.fillStyle = 'rgba(160,90,255,.12)'; g.fillRect(0, 22, W, 24);
      // ネオンサイン
      const on = Math.floor(t/700) % 5 !== 4;
      g.save(); g.font = '900 13px "M PLUS 1p", sans-serif'; g.textAlign = 'center';
      g.shadowColor = '#4FF3FF'; g.shadowBlur = on ? 12 : 0; g.fillStyle = on ? '#B8FBFF' : '#2a5a6a'; g.fillText('GAME', 268, 56);
      g.shadowColor = '#FF3EA5'; g.fillStyle = on ? '#FFC4E4' : '#5a2a4a'; g.font = '900 9px "M PLUS 1p", sans-serif'; g.fillText('ON AIR', 268, 70); g.restore();
      // 左のモニター（画面が光る）
      g.fillStyle = '#0a0a14'; rrPath(g, 14, 50, 70, 44, 4); g.fill();
      const sg = g.createLinearGradient(18, 54, 80, 90); sg.addColorStop(0, `hsl(${(t/20)%360},80%,45%)`); sg.addColorStop(1, '#1a1a6a');
      g.fillStyle = sg; g.fillRect(18, 54, 62, 36);
      g.fillStyle = 'rgba(255,255,255,.12)'; for(let y=54 + (t/40 % 4); y<90; y+=4) g.fillRect(18, y, 62, 1);
      g.fillStyle = '#222'; g.fillRect(46, 94, 6, 10); g.fillRect(36, 104, 26, 3);
      // 棚とフィギュア
      g.fillStyle = '#3a2a5a'; g.fillRect(228, 86, 76, 4);
      [['#FF7FB0',236],['#7FD3FF',254],['#FFE14D',272],['#9B5CFF',290]].forEach(([c,x],k) => { g.fillStyle = c; rrPath(g, x - 5, 72 - (k%2)*4, 10, 14 + (k%2)*4, 3); g.fill(); });
      // 床とラグ
      g.fillStyle = '#1a1030'; g.fillRect(0, DESK, W, H - DESK);
      g.fillStyle = 'rgba(155,92,255,.35)'; g.beginPath(); g.ellipse(160, 150, 96, 12, 0, 0, 6.283); g.fill();
      g.fillStyle = 'rgba(79,243,255,.25)'; g.beginPath(); g.ellipse(160, 150, 80, 8, 0, 0, 6.283); g.fill();
    }
    // ステージ3：バーラウンジ
    function drawLounge(t){
      const wall = g.createLinearGradient(0,0,0,H); wall.addColorStop(0,'#2a1208'); wall.addColorStop(1,'#5a2a10');
      g.fillStyle = wall; g.fillRect(0,0,W,H);
      // 酒棚
      g.fillStyle = '#3a1a0a'; g.fillRect(70, 24, 180, 74);
      for(let r=0;r<3;r++){
        g.fillStyle = '#6a3a1a'; g.fillRect(70, 46 + r*24, 180, 3);
        for(let k=0;k<11;k++){
          const x = 78 + k*16, hh = 12 + ((k*7 + r*3) % 6), c = ['#3a6a2a','#8a2a1a','#c89a3a','#2a3a7a','#7a5a2a'][(k + r) % 5];
          g.fillStyle = c; rrPath(g, x, 46 + r*24 - hh, 8, hh, 2); g.fill();
          g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(x + 1.5, 46 + r*24 - hh + 3, 1.5, hh - 5);
        }
      }
      // 左右の赤いカーテン
      ['#8a0a1a','#b0142a'].forEach((c,k) => { g.fillStyle = c;
        for(let i=0;i<4;i++){ g.beginPath(); g.moveTo(i*10 + k*4, 0); g.quadraticCurveTo(i*10 + 6 + Math.sin(t/900 + i)*2, 80, i*10 + k*4, H); g.lineTo(i*10 + 10 + k*4, H); g.lineTo(i*10 + 10 + k*4, 0); g.fill(); }
        for(let i=0;i<4;i++){ const x = W - 40 + i*10; g.beginPath(); g.moveTo(x + k*4, 0); g.quadraticCurveTo(x + 4 + Math.sin(t/900 + i)*2, 80, x + k*4, H); g.lineTo(x + 10 + k*4, H); g.lineTo(x + 10 + k*4, 0); g.fill(); } });
      // スポットライト
      const sp = g.createRadialGradient(160, 0, 4, 160, 70, 120); sp.addColorStop(0, 'rgba(255,230,160,.45)'); sp.addColorStop(1, 'rgba(255,230,160,0)');
      g.fillStyle = sp; g.beginPath(); g.moveTo(140, 0); g.lineTo(180, 0); g.lineTo(250, H); g.lineTo(70, H); g.fill();
      // シャンデリアの光
      for(let k=0;k<7;k++){ g.globalAlpha = .5 + .5*Math.abs(Math.sin(t/400 + k)); g.fillStyle = '#FFE9A0'; g.beginPath(); g.arc(130 + k*10, 14 + (k%2)*3, 1.6, 0, 6.283); g.fill(); }
      g.globalAlpha = 1;
      // カウンター（床）
      g.fillStyle = '#2a1206'; g.fillRect(0, DESK, W, H - DESK);
      g.fillStyle = '#8a5a2a'; g.fillRect(0, DESK, W, 3);
    }
    // ステージ4：実家（和室）。障子越しの光がゆっくり揺れ、ろうそくの火がまたたく
    function drawJikka(t){
      if(JIKKA_BG.complete && JIKKA_BG.naturalWidth) g.drawImage(JIKKA_BG, 0, 0, W, H);
      else { g.fillStyle = '#7a5a2a'; g.fillRect(0,0,W,H); }
      g.save();
      g.globalAlpha = .08 + .05*Math.sin(t/1700); g.fillStyle = '#FFE9B0'; g.fillRect(0,0,W,H);
      const fl = .6 + .4*Math.abs(Math.sin(t/90) * Math.sin(t/37));
      const cg = g.createRadialGradient(134, 95, 0, 134, 95, 14); cg.addColorStop(0, `rgba(255,220,120,${.7*fl})`); cg.addColorStop(1, 'rgba(255,200,80,0)');
      g.globalAlpha = 1; g.fillStyle = cg; g.beginPath(); g.arc(134, 95, 14, 0, 6.283); g.fill();
      g.restore();
    }
    function drawStageBg(t){ if(S.stg === 2) drawGameRoom(t); else if(S.stg === 3) drawLounge(t); else if(S.stg === 4) drawJikka(t); else drawRoom(t); }

    // ポーズごとの演出（粒）
    function poseFx(tag, t, x, top, h){
      const P = S.pfx, R = Math.random;
      if(tag === 'fire' && R() < .7) P.push({k:'fire', x:x + (R()-.5)*h*.8, y:top + h*.95, vx:(R()-.5)*.3, vy:-1 - R()*1.2, life:1, s:3 + R()*4});
      if(tag === 'notes' && R() < .05) P.push({k:'txt', ch:R() < .5 ? '♪' : '♫', x:x + (R() < .5 ? -1 : 1)*h*.45, y:top + h*.3, vx:(R()-.5)*.3, vy:-.5, life:1, c:pick(['#FF4F8B','#4FA8FF','#FFB000'])});
      if(tag === 'hearts' && R() < .06) P.push({k:'heart', x:x + (R()-.5)*h*.9, y:top + h*.4, vx:(R()-.5)*.3, vy:-.6, life:1, s:3 + R()*3});
      if(tag === 'sparkle' && R() < .08) P.push({k:'spark', x:x + (R()-.5)*h, y:top + R()*h*.7, life:1, s:2 + R()*3});
      if(tag === 'zzz' && R() < .03) P.push({k:'txt', ch:'Z', x:x - h*.3, y:top + h*.35, vx:-.25, vy:-.45, life:1, c:'#4FA8FF', big:1});
      if(tag === 'drink' && R() < .2) P.push({k:'bub', x:x - h*.25 + (R()-.5)*8, y:top + h*.25, vx:(R()-.5)*.3, vy:-.6 - R()*.4, life:1});
      if(tag === 'tears' && R() < .25) P.push({k:'drop', x:x + (R() < .5 ? -1 : 1)*h*.18, y:top + h*.35, vx:(R() < .5 ? -1 : 1)*(1 + R()), vy:-1.2, life:1});
      if(tag === 'confetti' && R() < .5) P.push({k:'conf', x:R()*W, y:-4, vx:(R()-.5)*.6, vy:.8 + R()*.8, life:1.6, c:pick(['#FF4F8B','#4FF3FF','#FFE14D','#9B5CFF','#5DFFB0']), r:R()*6});
      if(tag === 'game' && R() < .15) P.push({k:'pix', x:x + (R()-.5)*h*.6, y:top + h*.75, vx:(R()-.5)*.8, vy:-.8 - R()*.5, life:1, c:pick(['#4FF3FF','#FF4F8B','#5DFFB0'])});
      if(tag === 'question' && R() < .03) P.push({k:'txt', ch:'?', x:x + h*.4, y:top + h*.2, vx:.1, vy:-.4, life:1, c:'#4FA8FF', big:1});
    }
    function drawPoseFx(){
      S.pfx = S.pfx.filter(p => p.life > 0);
      g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
      for(const p of S.pfx){
        p.x += p.vx || 0; p.y += p.vy || 0; p.life -= p.k === 'conf' ? .008 : .012;
        if(p.life <= 0) continue;
        g.globalAlpha = Math.max(0, Math.min(1, p.life));
        if(p.k === 'fire'){ g.fillStyle = `hsl(${20 + p.life*25},100%,${45 + p.life*15}%)`; g.beginPath(); g.arc(p.x, p.y, Math.max(0, p.s*p.life), 0, 6.283); g.fill(); }
        if(p.k === 'txt'){ g.font = `bold ${p.big ? 14 : 12}px sans-serif`; g.fillStyle = p.c; g.lineWidth = 2; g.strokeStyle = '#fff'; g.strokeText(p.ch, p.x, p.y); g.fillText(p.ch, p.x, p.y); }
        if(p.k === 'heart'){ g.fillStyle = '#FF4F8B'; heartPath(g, p.x, p.y, p.s); g.fill(); }
        if(p.k === 'spark'){ g.globalAlpha *= Math.sin(p.life*Math.PI); sparkle(p.x, p.y, p.s, '#FFE14D'); }
        if(p.k === 'bub'){ g.strokeStyle = '#E8F8FF'; g.lineWidth = .9; g.beginPath(); g.arc(p.x, p.y, 1.8, 0, 6.283); g.stroke(); }
        if(p.k === 'drop'){ p.vy += .08; g.fillStyle = '#7FD3FF'; g.beginPath(); g.ellipse(p.x, p.y, 1.8, 2.6, 0, 0, 6.283); g.fill(); }
        if(p.k === 'conf'){ p.r += .15; g.fillStyle = p.c; g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillRect(-2, -1, 4, 2); g.restore(); }
        if(p.k === 'pix'){ g.fillStyle = p.c; g.fillRect(p.x, p.y, 2.5, 2.5); }
      }
      g.restore();
    }

    // 通常ステージのキャラ（ポーズ＋動き）
    function drawStageChar(t, mood){
      const cat = moodToCat(mood);
      if(S.npCat !== cat || (cat === 'idle' && t - S.npT > 3400) || S.np === null) choosePose(cat, t);
      const set = STAGE_POSES[S.stg], img = sheetImg(set.sheet), tag = POSE_FX[set.sheet][S.np];
      if(!(img.complete && img.naturalWidth)) return;
      const pe = t - S.npT, beat = bgm.beat();
      const sz = spriteSize(img, S.np, 118, 210);
      let x = 160, bottom = 164, size = sz.h, rot = 0, scx = 1, scy = 1;
      // ポーズ切り替え時は縮ませず、少しだけ膨らんで戻る
      const pop = pe < 240 ? 1 + .05*Math.sin(pe/240*Math.PI) : 1;
      // 共通：拍に合わせて軽く左右に揺れる（縦に潰す動きはしない）
      rot = Math.sin(beat*Math.PI)*.035;
      // ポーズごとの動き
      if(tag === 'fire' || tag === 'kiai'){ x += (Math.random()-.5)*3; rot = 0; }
      if(tag === 'speed'){ x += Math.max(0, 1 - pe/320)*170; rot = -.05; }
      if(tag === 'zzz' || tag === 'chill' || tag === 'sway'){ rot = Math.sin(t/900)*.05; }
      if(tag === 'bow'){ rot = Math.max(0, Math.sin(t/500))*.06; }
      if(tag === 'game'){ bottom -= Math.abs(Math.sin(t/120))*1.5; }
      if(tag === 'impact' || tag === 'confetti' || cat === 'happy'){ bottom -= Math.abs(Math.sin(t/150))*8; }
      if(cat === 'sad'){ rot = Math.sin(t/1200)*.03; }
      size *= pop;
      const top = bottom - size;
      // 背面の演出
      if(tag === 'kiai'){ const k = Math.max(0, 1 - (t - S.kiaiT)/600); g.fillStyle = `rgba(255,30,30,${.12 + .25*k})`; g.fillRect(0,0,W,H); }
      if(tag === 'game'){ g.save(); g.globalAlpha = .25 + .15*Math.sin(t/60); g.fillStyle = '#4FA8FF'; g.beginPath(); g.ellipse(x, bottom - size*.25, size*.45, size*.3, 0, 0, 6.283); g.fill(); g.restore(); }
      if(tag === 'speed'){ g.save(); g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1.5;
        for(let k=0;k<8;k++){ const y = top + 20 + k*12, len = 30 + (k*13 % 40); const ox = (t/3 + k*37) % 120; g.beginPath(); g.moveTo(x + 40 + ox, y); g.lineTo(x + 40 + ox + len, y); g.stroke(); } g.restore(); }
      if(tag === 'impact'){ const k = (t % 600)/600; g.save(); g.strokeStyle = `rgba(255,225,77,${1 - k})`; g.lineWidth = 3;
        for(let i=0;i<10;i++){ const a = i/10*6.283; g.beginPath(); g.moveTo(x + Math.cos(a)*(40 + k*30), top + size*.4 + Math.sin(a)*(30 + k*20)); g.lineTo(x + Math.cos(a)*(52 + k*30), top + size*.4 + Math.sin(a)*(40 + k*20)); g.stroke(); } g.restore(); }
      // 本体
      g.save(); g.translate(x, bottom); g.rotate(rot); g.scale(scx, scy);
      const dw = sz.w*pop, dh = sz.h*pop;
      g.drawImage(img, sz.b.x, sz.b.y, sz.b.w, sz.b.h, -dw/2, -dh, dw, dh); g.restore();
      // 前面の演出
      if(tag === 'glint'){ const k = (t % 1600)/1600; if(k < .3){ g.save(); g.globalAlpha = 1 - k/.3; g.fillStyle = '#fff';
        g.translate(x - 20 + k*140, top + size*.33); g.rotate(-.6); g.fillRect(-1.5, -14, 3, 28); g.restore(); sparkle(x - 20 + k*140, top + size*.33, 5, '#fff'); } }
      if(tag === 'drink' && Math.floor(t/500) % 2 === 0){ g.save(); g.font = '900 11px "M PLUS 1p", sans-serif'; g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 3; g.textAlign = 'center';
        g.strokeText('ゴクッ', x + size*.42, top + 14); g.fillText('ゴクッ', x + size*.42, top + 14); g.restore(); }
      poseFx(tag, t, x, top, size);
      drawPoseFx();
    }
    // 大当たり確定ステージ：金と赤の光の中で、おじいちゃんがガッツポーズ
    function drawConfirmStage(t){
      const bg = g.createRadialGradient(W/2, H*.7, 10, W/2, H*.6, 230);
      bg.addColorStop(0, '#FFE58A'); bg.addColorStop(.35, '#FF8A1E'); bg.addColorStop(.7, '#C0102A'); bg.addColorStop(1, '#4a0010');
      g.fillStyle = bg; g.fillRect(0,0,W,H);
      // 回転する光の帯
      g.save(); g.translate(W/2, H*.72); g.rotate(t/2600);
      for(let i=0;i<18;i++){ g.rotate(Math.PI/9); g.fillStyle = i%2 ? 'rgba(255,255,255,.16)' : 'rgba(255,230,120,.12)'; g.beginPath(); g.moveTo(0,0); g.lineTo(260,-26); g.lineTo(260,26); g.fill(); }
      g.restore();
      // 左右のスポットライト
      [[40, .5], [280, -.5]].forEach(([x, a]) => { g.save(); g.translate(x, 0); g.rotate(a*Math.sin(t/1400)*.5);
        const sp = g.createLinearGradient(0,0,0,H); sp.addColorStop(0,'rgba(255,255,220,.5)'); sp.addColorStop(1,'rgba(255,255,220,0)');
        g.fillStyle = sp; g.beginPath(); g.moveTo(-6,0); g.lineTo(6,0); g.lineTo(40,H); g.lineTo(-40,H); g.fill(); g.restore(); });
      // 降り注ぐ金の粒
      for(let k=0;k<26;k++){ const x = (k*47 + Math.sin(t/700 + k)*10) % W, y = ((t/12 + k*29) % (H + 20)) - 10;
        g.globalAlpha = .8; sparkle(x, y, 2 + (k%3), k%2 ? '#FFF3B0' : '#FFD23A'); }
      g.globalAlpha = 1;
      // ステージの床
      g.fillStyle = 'rgba(60,0,10,.6)'; g.fillRect(0, 140, W, 20);
      g.fillStyle = '#F2C14E'; g.fillRect(0, 140, W, 2);
      // おじいちゃん：ガッツポーズで弾む
      if(OJII.complete && OJII.naturalWidth){
        const h = 86, w = h * OJII.naturalWidth / OJII.naturalHeight;
        const hop = Math.abs(Math.sin(t/180))*5, rot = Math.sin(t/360)*.06;
        g.save(); g.translate(W/2, 158 - hop); g.rotate(rot);
        g.shadowColor = 'rgba(255,240,180,.9)'; g.shadowBlur = 18;
        g.drawImage(OJII, -w/2, -h, w, h); g.restore();
      }
      if(Math.random() < .15) hearts(1, true);
    }

    // ================================================================
    // バトル画面（4種類）：左にコウジ、右に相手。種類ごとに見せ方が変わる
    // ================================================================
    const HERO_POSE = {ready:9, attack:4, damage:10, pinch:7, defeat:12, win:2, dash:14, mic:8};
    const RAP_HERO = ['配信つけたら即満員 / 俺のトークは全部本音', 'ギフトより大事なリスナー / 今夜も回すぜスロッター',
                      'ペカったランプで夜明けまで / お前の声はもう聞こえねぇ', '名古屋仕込みの勢いで / ランキング頂上一直線'];
    const RAP_FOE  = ['自撮り棒で天下取り / お前の配信ただの素通り', 'ギフトの数ならこっちが上 / 見てろよすぐに頂上',
                      'コメント欄はガラ空きだ / 寝言はベッドで言いな', 'マイクの握り方から出直しな / 勝負はもう決まりだな'];
    const EVENT_RIVALS = ['ミラクルあゆ', 'しろくまP', 'よるのりん', 'ネオン姫', 'ゆめかわ亭'];
    function enemyCell(row, col){ const img = ENEMY_SPRITES, cell = img.naturalWidth / 6; return [col*cell, row*cell, cell]; }
    function drawFoe(row, pose, x, bottom, h, flash){
      const img = ENEMY_SPRITES; if(!(img.complete && img.naturalWidth)) return;
      const col = {idle:0, attack:1, damage:2, pinch:3, defeat:4, win:5}[pose];
      const [sx, sy, cell] = enemyCell(row, col);
      g.save(); g.translate(x, bottom); if(flash) g.filter = 'brightness(2.2)';
      g.drawImage(img, sx, sy, cell, cell, -h/2, -h, h, h); g.restore();
    }
    function drawLiver(i, ko, x, bottom, h, a = 1){
      const img = ENEMY_SPRITES; if(!(img.complete && img.naturalWidth)) return;
      const [sx, sy, cell] = enemyCell(ko ? 3 : 2, i);
      g.save(); g.globalAlpha *= a; g.translate(x, bottom);
      g.drawImage(img, sx, sy, cell, cell, -h/2, -h, h, h); g.restore();
    }
    function drawHeroSprite(idx, x, bottom, h){
      const sz = spriteSize(ST_A, idx, h, h*1.6);
      g.save(); g.translate(x, bottom);
      g.drawImage(ST_A, sz.b.x, sz.b.y, sz.b.w, sz.b.h, -sz.w/2, -sz.h, sz.w, sz.h); g.restore();
    }
    // 覚醒町田さんで戦う（コウジ用のポーズ番号を、町田さんの近いポーズに置き換える）
    const MACHIDA_FIGHT = {9:0, 4:6, 14:21, 10:9, 7:17, 12:14, 2:20, 8:24};
    function drawMachidaFighter(heroPose, x, bottom, h){
      if(!(MACHIDA.complete && MACHIDA.naturalWidth)) return;
      const idx = MACHIDA_FIGHT[heroPose] ?? 0, sz = spriteSize(MACHIDA, idx, h, h*1.5);
      g.save(); g.translate(x, bottom);
      if(idx === 6 || idx === 21){ g.shadowColor = 'rgba(255,140,40,.9)'; g.shadowBlur = 14; }
      g.drawImage(MACHIDA, sz.b.x, sz.b.y, sz.b.w, sz.b.h, -sz.w/2, -sz.h, sz.w, sz.h); g.restore();
    }
    // アツさの星（★5つ中いくつ光るか）。S6ライバーは虹色の星
    function drawStars(b, cx, cy, t){
      const n = b.stars || 1, r = 4.6, gap = 11;
      g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; rrPath(g, cx - 31, cy - 6.5, 62, 13, 6.5); g.fill();
      for(let i=0;i<5;i++){
        const x = cx + (i - 2)*gap, on = i < n;
        g.beginPath();
        for(let k=0;k<10;k++){ const rr = k % 2 ? r*.45 : r, a = -Math.PI/2 + k*Math.PI/5; g.lineTo(x + Math.cos(a)*rr, cy + Math.sin(a)*rr); }
        g.closePath();
        if(on){
          g.fillStyle = b.rainbow ? `hsl(${(t/3 + i*60) % 360},100%,60%)` : '#FFD23A';
          g.shadowColor = g.fillStyle; g.shadowBlur = b.rainbow ? 10 : 6;
        } else { g.fillStyle = 'rgba(255,255,255,.18)'; g.shadowBlur = 0; }
        g.fill();
      }
      g.restore();
    }
    function bText(text, y, size, color, stroke = '#2a0018', x = W/2){
      g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.font = `900 ${size}px "M PLUS 1p", sans-serif`; g.lineWidth = size*.22; g.strokeStyle = stroke;
      g.strokeText(text, x, y); g.fillStyle = color; g.fillText(text, x, y); g.restore();
    }
    // 背景（種類ごと）
    function drawBattleBg(type, t){
      const pal = {gun:['#1a2a4a','#0a1020','#04060c'], rap:['#5a1a6a','#250a3a','#0a0418'], event:['#ffcf5a','#e0602a','#5a1030'], s6:['#ff9ad6','#b03a9a','#3a0a40']}[type];
      const bg = g.createRadialGradient(W/2, 120, 10, W/2, 90, 220);
      bg.addColorStop(0, pal[0]); bg.addColorStop(.6, pal[1]); bg.addColorStop(1, pal[2]);
      g.fillStyle = bg; g.fillRect(0,0,W,H);
      if(type === 'gun'){   // 夜の路地：ビルの影と雨
        g.fillStyle = '#060a14'; [[0,40,40],[44,60,30],[80,30,26],[230,50,34],[268,26,52]].forEach(([x,y,w]) => g.fillRect(x, y, w, 140 - y));
        g.fillStyle = 'rgba(255,220,120,.6)'; for(let k=0;k<14;k++) g.fillRect(6 + (k*23)%300, 50 + (k*37)%70, 3, 4);
        g.strokeStyle = 'rgba(180,200,255,.25)'; g.lineWidth = 1;
        for(let k=0;k<30;k++){ const x = (k*41 + t/6) % W, y = (k*53 + t/2) % H; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 3, y + 9); g.stroke(); }
      } else {
        g.save(); g.globalAlpha = type === 'event' ? .25 : .18; g.translate(W/2, 160); g.rotate(t/4000);
        for(let i=0;i<12;i++){ g.rotate(Math.PI/6); g.fillStyle = i%2 ? '#FF4F8B' : (type === 'event' ? '#fff' : '#4FC8FF'); g.beginPath(); g.moveTo(0,0); g.lineTo(240,-20); g.lineTo(240,20); g.fill(); }
        g.restore();
        if(type === 'rap' || type === 'event'){   // 観客のシルエット
          g.fillStyle = 'rgba(0,0,0,.55)';
          for(let k=0;k<16;k++){ const x = 10 + k*20, bob = Math.abs(Math.sin(t/180 + k))*3; g.beginPath(); g.arc(x, 150 - bob, 8, 0, 6.283); g.fill(); g.fillRect(x - 9, 152 - bob, 18, 10); }
        }
        if(type === 's6') for(let k=0;k<10;k++) sparkle((k*37 + t/20) % W, 20 + (k*29) % 110, 2 + k%3, '#fff');
      }
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 140, W, 20);
      g.fillStyle = '#F2C14E'; g.fillRect(0, 140, W, 1.5);
    }
    function hpBars(b, foeName){
      S.bhpView[0] += (b.hp[0] - S.bhpView[0]) * .08; S.bhpView[1] += (b.hp[1] - S.bhpView[1]) * .08;
      const bar = (x, w, v, name, right) => {
        g.fillStyle = 'rgba(0,0,0,.6)'; rrPath(g, x, 23, w, 13, 6); g.fill();
        const fw = (w - 4) * Math.max(0, v)/100, col = v > 50 ? '#5DFF8A' : v > 25 ? '#FFE14D' : '#FF4F4F';
        g.fillStyle = col; rrPath(g, right ? x + w - 2 - fw : x + 2, 25, Math.max(4, fw), 9, 4); g.fill();
        g.font = 'bold 8px "M PLUS 1p", sans-serif'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
        g.textAlign = right ? 'right' : 'left'; g.fillText(name, right ? x + w : x, 42);
      };
      bar(8, 138, S.bhpView[0], 'コウジ', false);
      bar(174, 138, S.bhpView[1], foeName, true);
    }
    // イベント：ランキングボード
    function drawRanking(b, t, highlight){
      const rank = b.rankView;
      const names = EVENT_RIVALS.slice(0, 4);
      g.save(); g.fillStyle = 'rgba(20,0,30,.75)'; rrPath(g, 176, 22, 136, 112, 8); g.fill();
      g.strokeStyle = '#F2C14E'; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = '#FFE14D'; g.font = 'bold 8.5px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.fillText('MACHIDA CUP ランキング', 244, 32);
      let others = 0;
      for(let r=1;r<=5;r++){
        const y = 44 + (r-1)*18, me = r === rank;
        g.fillStyle = me ? (highlight ? `hsl(${(t/4)%360},90%,55%)` : '#FF4F8B') : 'rgba(255,255,255,.1)';
        rrPath(g, 182, y - 7, 124, 15, 5); g.fill();
        g.fillStyle = r === 1 ? '#FFE14D' : '#fff'; g.font = 'bold 9px "M PLUS 1p", sans-serif'; g.textAlign = 'left';
        g.fillText(`${r}位`, 188, y + 1);
        g.fillText(me ? 'コウジ' : names[others++] || '', 214, y + 1);
        if(r === 1) g.fillText('👑', 288, y + 1);
      }
      g.restore();
    }
    function drawBattle(t){
      const b = S.bt, A = S.bAct, ae = A ? t - A.t0 : 1e9, type = b.type;
      drawBattleBg(type, t);
      const foeName = BATTLES[type].foe;
      // 見せ方の共通部分
      let hx = 78, fx = 242, hp = b.hp[0] < 35 ? HERO_POSE.pinch : HERO_POSE.ready, fp = b.hp[1] < 35 ? 'pinch' : 'idle';
      let flashF = false, shakeH = 0, shakeF = 0, overlay = 0, txt = null, bubble = null;
      b.rankView = b.rankView ?? b.rank; b.aliveView = b.aliveView ?? b.alive;
      if(A && (A.type === 'hero' || A.type === 'enemy') && ae < 2200){
        const lunge = ae < 300 ? ae/300 : ae < 600 ? 1 : Math.max(0, 1 - (ae - 600)/400);
        const hit = ae >= 300 && ae < 700;
        if(type === 'rap'){
          const lines = A.type === 'hero' ? RAP_HERO : RAP_FOE;
          bubble = {side:A.type, text:lines[A.dmg % lines.length]};
          if(A.type === 'hero'){ hp = HERO_POSE.mic; if(hit){ fp = 'damage'; shakeF = 3; } }
          else { fp = 'attack'; if(hit){ hp = HERO_POSE.damage; shakeH = 3; } }
          txt = A.type === 'hero' ? 'コウジのバース！' : 'MCギフトのバース！';
        } else if(type === 'event'){
          hp = A.type === 'hero' ? HERO_POSE.win : HERO_POSE.damage;
          txt = A.type === 'hero' ? '↑ ランクアップ！' : '↓ ランクダウン…';
          if(ae > 400) b.rankView = A.snap.rank;
        } else if(type === 's6'){
          if(A.type === 'hero'){ hx += lunge*60; hp = HERO_POSE.dash; txt = `${A.dmg}人撃破！`; if(ae > 400) b.aliveView = A.snap.alive; }
          else { hp = HERO_POSE.damage; shakeH = hit ? 4 : 0; txt = 'キャー！囲まれた！'; }
        } else {   // 通常バトル（黒服・拳銃）
          if(A.type === 'hero'){ hx += lunge*70; hp = HERO_POSE.attack; if(hit){ fp = 'damage'; shakeF = 4; flashF = ae < 380; overlay = Math.max(0, 1 - (ae-300)/250); } txt = 'コウジの攻撃！'; }
          else { fp = 'attack'; if(hit){ hp = HERO_POSE.damage; shakeH = 4; } txt = '黒服の銃撃！';
            if(ae > 250 && ae < 700){ sparkle(fx - 62, 108, 14, '#FFE14D'); bText('BANG!', 92, 14, '#FF2D2D', '#000', fx - 80); } }
        }
        if(type !== 'event' && type !== 's6' && ae >= 300 && ae < 1300){ g.save(); g.globalAlpha = Math.min(1, (1300 - ae)/300); bText(`-${A.dmg}`, 70 - (ae-300)/30, 16, '#FFE14D'); g.restore(); }
        if(type === 'gun' || type === 'rap'){ if(ae > 300) b.hp = A.snap.hp; }
      }
      if(A && A.type === 'intro'){
        const k = Math.min(1, ae/500);
        hx = -60 + k*138; fx = W + 60 - k*138;
        if(ae > 300 && ae < 1800) txt = S.bDev && ae < 1000 ? 'バトル発展!!' : BATTLES[type].name;
      }
      if(A && A.type === 'final'){
        txt = ae < 1600 ? ({event:'結果発表！', s6:'ラスト勝負！'}[type] || '最終決戦！') : null;
        hp = HERO_POSE.attack; fp = 'attack';
        const aura = .4 + .3*Math.sin(t/80); g.save(); g.globalAlpha = aura; g.fillStyle = '#FFE14D'; g.beginPath(); g.ellipse(hx, 110, 40, 50, 0, 0, 6.283); g.fill(); g.restore();
      }
      if(A && A.type === 'clash'){
        const k = Math.min(1, ae/350); if(type !== 'event'){ hx += k*58; fx -= k*58; } hp = HERO_POSE.attack; fp = 'attack';
        overlay = ae > 350 ? Math.max(0, 1 - (ae - 350)/600) : 0;
        txt = ae > 350 ? (type === 'event' ? '集計中…' : '決着…！') : null;
      }
      let resWin = null;
      if(A && A.type === 'result'){
        resWin = A.win;
        if(A.win){
          if(A.comeback && ae < 1100){ hp = HERO_POSE.defeat; fp = 'win'; txt = ae < 700 ? 'やられた…!?' : null; }
          else { hp = HERO_POSE.win; fp = 'defeat';
            txt = A.comeback && ae < 1900 ? '復活!! 逆転勝利!!' : ({event:'優勝!!', s6:'全員撃破!!', rap:'WINNER!!'}[type] || 'WIN!!');
            b.rankView = 1; b.aliveView = 0;
            if(Math.random() < .5) S.gisiFx.push({kind:'heart', x:Math.random()*W, y:160, vx:(Math.random()-.5), vy:-2 - Math.random()*1.5, s:4 + Math.random()*3, life:1}); }
          if(A.comeback && ae > 1100 && ae < 1400) overlay = 1 - (ae - 1100)/300;
        } else { hp = HERO_POSE.defeat; fp = 'win'; txt = ({event:'2位…', s6:'敗北…', rap:'LOSE…'}[type] || 'LOSE…'); b.rankView = 2; }
      }
      // ---- 描画：種類ごとの右側 ----
      if(type === 'gun' || type === 'rap'){
        hpBars(b, foeName);
        drawFoe(type === 'gun' ? 0 : 1, fp, fx + (Math.random()-.5)*shakeF, 157, 80, flashF);
        if(type === 'rap' && fp === 'attack') for(let i=0;i<3;i++){ g.strokeStyle = '#FF4F8B'; g.lineWidth = 3; g.beginPath(); g.arc(fx - 40, 100, 14 + i*10 + (t/40 % 10), Math.PI*.7, Math.PI*1.3); g.stroke(); }
      } else if(type === 'event'){
        drawRanking(b, t, resWin === true);
      } else {   // S6：残っているライバーを並べる
        const alive = resWin === true ? 0 : resWin === false ? 6 : b.aliveView;
        g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; rrPath(g, 222, 22, 92, 15, 7); g.fill();
        g.fillStyle = '#FFE14D'; g.font = 'bold 9px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(`S6ライバー 残り${alive}人`, 268, 30); g.restore();
        const pos = [[200,122],[236,116],[272,122],[300,116],[218,156],[260,158]];
        for(let i=0;i<6;i++){
          const ko = i >= alive, [x, y] = pos[i];
          const bob = ko ? 0 : Math.abs(Math.sin(t/200 + i))*3;
          drawLiver(i, ko, x + (A && A.type === 'enemy' && !ko ? -Math.min(1, ae/300)*20 : 0), y - bob, 46, ko ? .55 : 1);
        }
      }
      const leftCol = type === 'event' || type === 's6';   // 右側にボードや人がいる種類は、文字が左上に来る
      if(type === 's6') drawMachidaFighter(hp, hx + (Math.random()-.5)*shakeH, 157, 68);   // S6ライバー戦は覚醒町田さん
      else drawHeroSprite(hp, hx + (Math.random()-.5)*shakeH, 157, leftCol ? 64 : 72);
      drawGisi(t);
      // ラップの吹き出し
      if(bubble){
        const lines = bubble.text.split(' / ');
        g.save(); g.font = 'bold 9px "M PLUS 1p", sans-serif';
        const w = Math.max(...lines.map(l => g.measureText(l).width)) + 16, x = bubble.side === 'hero' ? 8 : W - 8 - w;
        g.fillStyle = 'rgba(255,255,255,.95)'; rrPath(g, x, 46, w, 28, 8); g.fill();
        g.strokeStyle = bubble.side === 'hero' ? '#FF4F8B' : '#7A3DD6'; g.lineWidth = 2; g.stroke();
        g.fillStyle = '#2a0018'; g.textBaseline = 'middle'; g.textAlign = 'left';
        lines.forEach((l, k) => g.fillText(l, x + 8, 54 + k*12));
        g.restore();
      }
      if(overlay > 0){ g.fillStyle = `rgba(255,255,255,${overlay*.85})`; g.fillRect(0,0,W,H); }
      // 決着前の溜め：一瞬暗転
      if(A && A.type === 'clash' && ae > 350 && ae < 1250){ g.fillStyle = `rgba(0,0,0,${Math.min(.85, (ae - 350)/300)})`; g.fillRect(0,0,W,H); txt = '…'; }
      // 星昇格・乱入昇格
      const be = t - S.bBannerT;
      if(S.bBanner && be < 1600){ const k = Math.min(1, be/200);
        g.save(); g.globalAlpha = be > 1300 ? (1600 - be)/300 : 1; g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0,0,W,H);
        g.translate(W/2, 86); g.scale(.6 + .4*easeBack(k), .6 + .4*easeBack(k)); g.translate(-W/2, -86);
        bText(S.bBanner, 86, 16, `hsl(${(t/3)%360},100%,65%)`); g.restore(); }
      if(txt && !bubble){
        const big = /WIN|優勝|撃破!!|復活|WINNER/.test(txt) && A && A.type === 'result';
        const col = resWin === false ? '#9FB8FF' : big ? '#FFE14D' : '#fff';
        const p = 1 + .04*Math.sin(t/90), y = big ? 74 : 77;
        const cx = leftCol ? 86 : W/2;
        g.save(); g.translate(cx, y); g.scale(p, p); g.translate(-cx, -y);
        bText(txt, y, big ? 20 : 12.5, col, '#2a0018', cx); g.restore();
      }
      // タイトルとラウンド
      if((!A || A.type !== 'result') && !bubble){   // ラップの吹き出しが出ている間はタイトル帯を隠す
        const tx = (type === 'event' || type === 's6') ? 86 : W/2;
        g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; rrPath(g, tx - 78, 44, 156, 13, 6); g.fill();
        g.fillStyle = '#FFE14D'; g.font = 'bold 8px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(`${BATTLES[type].name}　${b.game >= 5 ? 'FINAL' : `ROUND ${b.game}/5`}`, tx, 50.5); g.restore();
        drawStars(b, tx, 63.5, t);
      }
    }

    // ================================================================
    // 次回予告の画面：配信アプリの「次回配信のお知らせ」風のサムネ
    // ================================================================
    const PV_COLORS = ['#3a7bff', '#2fbf71', '#ff3b5c', '#F2C14E', 'rainbow'];
    function pvColor(i, t){ return PV_COLORS[i] === 'rainbow' ? `hsl(${(t/3)%360},95%,58%)` : PV_COLORS[i]; }
    function drawCast(pv, x, bottom, h, t){
      g.save(); if(pv.silhouette && !S.pvRevealed) g.filter = 'brightness(0)';
      if(pv.kind === 'battle'){
        const b = pv.battle;
        if(b.type === 'gun' || b.type === 'rap') drawFoe(b.type === 'gun' ? 0 : 1, 'idle', x, bottom, h);
        else if(b.type === 's6') drawLiver(Math.floor(t/600) % 6, false, x, bottom, h);
        else { g.font = `${h*.7}px sans-serif`; g.textAlign = 'center'; g.fillText('🏆', x, bottom - h*.45); }
      } else {
        const c = pv.cast;
        if(c === 0 && ST_A.complete){ const sz = spriteSize(ST_A, 1, h, h*1.4); g.drawImage(ST_A, sz.b.x, sz.b.y, sz.b.w, sz.b.h, x - sz.w/2, bottom - sz.h, sz.w, sz.h); }
        if(c === 1 && TUX.complete){ const w = h*TUX.naturalWidth/TUX.naturalHeight; g.drawImage(TUX, x - w/2, bottom - h, w, h); }
        if(c === 2 && OJII.complete){ const w = h*OJII.naturalWidth/OJII.naturalHeight; g.drawImage(OJII, x - w/2, bottom - h, w, h); }
        if(c === 3 && MACHIDA.complete){ const sz = spriteSize(MACHIDA, 3, h, h*1.4); g.drawImage(MACHIDA, sz.b.x, sz.b.y, sz.b.w, sz.b.h, x - sz.w/2, bottom - sz.h, sz.w, sz.h); }
      }
      g.restore();
      if(pv.silhouette && !S.pvRevealed){ g.save(); g.font = '900 22px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.fillStyle = '#fff';
        g.strokeStyle = '#000'; g.lineWidth = 4; g.strokeText('？？？', x, bottom - h*.5); g.fillText('？？？', x, bottom - h*.5); g.restore(); }
    }
    function drawPreview(t){
      const pv = S.pv, e = t - S.pvT, D = PV_DUR;
      if(e > D){ S.pv = null; return; }
      const out = e > D - 300 ? (D - e)/300 : 1;
      g.save(); g.globalAlpha = out;
      // 背景：斜めのストライプ
      g.fillStyle = '#120a2a'; g.fillRect(0,0,W,H);
      g.fillStyle = 'rgba(255,255,255,.05)';
      for(let x = -H + (t/30 % 24); x < W; x += 24){ g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 12, 0); g.lineTo(x + 12 + H, H); g.lineTo(x + H, H); g.fill(); }
      // 放送事故（プレミア）：最初はノイズ
      const accident = pv.kind === 'accident';
      if(accident && e < 1300){
        for(let y=0;y<H;y+=3){ g.fillStyle = `rgba(${150 + Math.random()*100|0},${150 + Math.random()*100|0},${150 + Math.random()*100|0},${.3 + Math.random()*.5})`; g.fillRect(0, y, W, 2); }
        g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0,0,W,H);
        bText('放送事故!?', 80, 24, '#fff', '#000');
        g.restore(); return;
      }
      // 見出し「次回予告」
      const hk = Math.min(1, e/250);
      g.save(); g.translate(-60*(1 - hk), 0);
      g.fillStyle = '#E0102A'; g.beginPath(); g.moveTo(6, 22); g.lineTo(96, 22); g.lineTo(88, 38); g.lineTo(6, 38); g.fill();
      g.fillStyle = '#fff'; g.font = '900 11px "M PLUS 1p", sans-serif'; g.textBaseline = 'middle'; g.fillText('次回予告', 14, 30.5);
      g.restore();
      // サムネのカード
      const ck = Math.min(1, Math.max(0, (e - 200)/300)), sc = .85 + .15*easeBack(ck);
      const col = pvColor(pv.color, t);
      g.save(); g.globalAlpha *= ck; g.translate(W/2, 96); g.scale(sc, sc); g.translate(-W/2, -96);
      g.fillStyle = col; rrPath(g, 14, 44, 292, 104, 10); g.fill();
      g.fillStyle = 'rgba(10,6,30,.9)'; rrPath(g, 18, 48, 284, 96, 8); g.fill();
      if(pv.color >= 3){ g.strokeStyle = col; g.lineWidth = 2; g.shadowColor = col; g.shadowBlur = 14; rrPath(g, 14, 44, 292, 104, 10); g.stroke(); g.shadowBlur = 0; }
      // 出演者
      drawCast(pv, 70, 142, 86, t);
      // 「配信予定」バッジと日時
      g.fillStyle = '#FF2D55'; rrPath(g, 124, 54, 56, 14, 4); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 8.5px "M PLUS 1p", sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText('配信予定', 132, 61.5);
      g.fillStyle = pv.date >= 3 ? '#FFE14D' : '#cfd8ff'; g.font = `bold ${pv.date >= 3 ? 10 : 9}px "M PLUS 1p", sans-serif`; g.fillText(PV_DATES[pv.date], 186, 61.5);
      // タイトル（書き換えは、古いタイトルに線を引いてから新しいタイトルを押す）
      const title = pv.kind === 'battle' ? `次回、${BATTLES[pv.battle.type].foe}と${BATTLES[pv.battle.type].name}！` : PV_TITLES[pv.title];
      const wrap = (txt, x, y, max) => { const out = []; let line = ''; for(const ch of txt){ if(g.measureText(line + ch).width > max){ out.push(line); line = ch; } else line += ch; } out.push(line); out.forEach((l,i) => g.fillText(l, x, y + i*17)); };
      g.font = '900 14px "M PLUS 1p", sans-serif';
      if(pv.kind === 'rewrite' && e < 1700){
        g.fillStyle = '#fff'; wrap(PV_TITLES[pv.from], 126, 86, 166);
        if(e > 1200){ const k2 = Math.min(1, (e - 1200)/300); g.strokeStyle = '#FF2D2D'; g.lineWidth = 3; g.beginPath(); g.moveTo(124, 84); g.lineTo(124 + 170*k2, 90); g.stroke(); }
      } else {
        const pop = pv.kind === 'rewrite' ? Math.min(1, (e - 1700)/180) : 1;
        g.save(); g.translate(126, 86); g.scale(1 + (1 - pop)*.6, 1 + (1 - pop)*.6); g.translate(-126, -86);
        g.fillStyle = pv.title >= 4 ? `hsl(${(t/3)%360},100%,65%)` : pv.title >= 3 ? '#FFE14D' : '#fff';
        wrap(title, 126, 86, 166); g.restore();
      }
      // 出演者名
      g.fillStyle = 'rgba(255,255,255,.65)'; g.font = '8px "M PLUS 1p", sans-serif';
      g.fillText(pv.kind === 'battle' ? 'バトル配信' : `出演：${pv.silhouette && !S.pvRevealed ? '？？？' : PV_CAST[pv.cast]}`, 126, 132);
      g.restore();
      // 盛り上がるコメント
      const lines = ['楽しみ！','絶対見る','待ってた！','神回の予感','通知オンにした','アツい','全裸待機','もう待てない'];
      for(let i=0;i<pv.comments;i++){
        const ce = e - 500 - i*180; if(ce < 0) continue;
        const x = W - (ce/1800)*(W + 80), y = 50 + (i*29) % 90;
        g.font = 'bold 10px "M PLUS 1p", sans-serif'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(lines[i % lines.length], x, y); g.fillStyle = '#fff'; g.fillText(lines[i % lines.length], x, y);
      }
      // 締め
      if(e > D - 900){ const k3 = Math.min(1, (e - (D - 900))/200); g.globalAlpha = out*k3; bText('次回もお楽しみに！', 150, 11, '#FFE14D', '#2a0018'); }
      g.restore();
    }
    // シルエットの正体を明かす（次のゲームのレバーON）
    function drawReveal(t){
      const e = t - S.rvT; if(e < 0 || e > 1600 || !S.rv) return;
      const k = Math.min(1, e/200), out = e > 1300 ? (1600 - e)/300 : 1;
      g.save(); g.globalAlpha = out;
      g.fillStyle = 'rgba(10,6,30,.75)'; g.fillRect(0,0,W,H);
      if(e < 160){ g.fillStyle = `rgba(255,255,255,${1 - e/160})`; g.fillRect(0,0,W,H); }
      g.translate(W/2, 96); g.scale(.7 + .3*easeBack(k), .7 + .3*easeBack(k)); g.translate(-W/2, -96);
      drawCast({...S.rv, silhouette:false}, W/2, 140, 100, t);
      bText(`出演者は…${PV_CAST[S.rv.cast]}！`, 36, 15, S.rv.cast === 3 ? '#FFE14D' : '#fff');
      g.restore();
    }

    // ================================================================
    // 特殊リーチの画面
    // ================================================================
    function speech(text, x, y, maxW, align = 'left', col = '#2a0018'){
      g.save(); g.font = 'bold 9.5px "M PLUS 1p", sans-serif';
      const lines = []; let line = '';
      for(const ch of text){ if(g.measureText(line + ch).width > maxW){ lines.push(line); line = ch; } else line += ch; }
      lines.push(line);
      const w = Math.max(...lines.map(l => g.measureText(l).width)) + 14, h = lines.length*12 + 8;
      const bx = align === 'left' ? x : x - w;
      g.fillStyle = 'rgba(255,255,255,.96)'; rrPath(g, bx, y, w, h, 7); g.fill();
      g.strokeStyle = '#FF4F8B'; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = col; g.textBaseline = 'middle'; g.textAlign = 'left';
      lines.forEach((l, i) => g.fillText(l, bx + 7, y + 10 + i*12));
      g.restore();
    }
    function srHeader(name, t){
      g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; rrPath(g, W/2 - 90, 22, 180, 15, 7); g.fill();
      g.fillStyle = `hsl(${(t/6)%360},90%,70%)`; g.font = 'bold 9px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(name, W/2, 29.5); g.restore();
    }
    function drawSR(t){
      const sr = S.sr, e = t - S.srT, game = sr.game, R = S.srRes;
      const re = R ? t - S.srResT : -1;
      // 背景
      const bgc = {icon:['#ffb3d9','#ff6fb0'], audition:['#3a2a6a','#120a2a'], carriage:['#1a2a6a','#060a24'], family:['#ffd9a0','#f08a4a'], house:['#9fd8ff','#4a9a5a'], hashiguchi:['#2a2a3a','#0a0a14']}[sr.type];
      const bg = g.createLinearGradient(0,0,0,H); bg.addColorStop(0, bgc[0]); bg.addColorStop(1, bgc[1]); g.fillStyle = bg; g.fillRect(0,0,W,H);
      if(sr.type !== 'audition' && sr.type !== 'hashiguchi' && sr.type !== 'carriage') for(let k=0;k<8;k++) sparkle((k*47 + t/30) % W, 30 + (k*23) % 100, 2 + k%2, '#fff');
      srHeader(SR_TYPES[sr.type].name, t);
      const big = txt => { const p = 1 + .05*Math.sin(t/90); g.save(); g.translate(W/2, 64); g.scale(p, p); g.translate(-W/2, -64); bText(txt, 64, 18, '#FFE14D'); g.restore(); };

      if(sr.type === 'icon'){
        const pk = sr.d.picked, xs = [70, 160, 250];
        xs.forEach((x, i) => {
          const sel = pk === i, k = sel && S.pickT ? Math.min(1, (t - S.pickT)/300) : 0;
          if(pk >= 0 && !sel){ g.globalAlpha = .35; }
          const r = 30 + k*10, cy = 96 - k*6;
          g.save(); g.beginPath(); g.arc(x, cy, r, 0, 6.283); g.fillStyle = '#fff'; g.fill(); g.clip();
          const fraud = sel && sr.success && t - S.pickT > 650;
          if(fraud){ g.translate((Math.random()-.5)*3, 0); drawFoe(1, 'pinch', x, cy + r + 6, r*2.4); }   // 正体（焦った顔）
          else drawLiver(sr.d.icons[i], false, x, cy + r + 4, r*2.3);
          g.restore();
          g.strokeStyle = sel ? '#FFE14D' : '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(x, cy, r, 0, 6.283); g.stroke();
          g.globalAlpha = 1;
          if(pk < 0){ sparkle(x + 24, 70, 4, '#fff'); g.font = 'bold 8px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.fillStyle = '#a0005a'; g.fillText('盛れてる♡', x, 136); }
        });
        if(pk < 0) bText('タップして選んで！', 148, 11, '#fff', '#a0005a');
        else if(t - S.pickT > 650) bText(sr.success ? 'アイコン詐欺発覚!!' : '本物でした…かわいい', 148, sr.success ? 15 : 12, sr.success ? '#FFE14D' : '#fff', sr.success ? '#a00000' : '#a0005a');
      }

      if(sr.type === 'audition'){
        drawHeroSprite(1, 56, 158, 78);
        if(game === 1){
          const msg = `えー、本日の日跨ぎスタメンを発表します。1番${sr.d.names[0]}、2番${sr.d.names[1]}、3番${sr.d.names[2]}！いけるか？！`;
          speech(msg.slice(0, Math.floor(e/45)), 92, 42, 190);
        } else {
          for(let i=0;i<3;i++){
            const y = 44 + i*34, shown = i < game - 1 || (i === game - 1);
            g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; rrPath(g, 104, y, 74, 26, 6); g.fill();
            g.fillStyle = '#FFE14D'; g.font = 'bold 8px "M PLUS 1p", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
            g.fillText(`${i + 1}番`, 110, y + 8); g.fillStyle = '#fff'; g.font = 'bold 9px "M PLUS 1p", sans-serif'; g.fillText(sr.d.names[i].slice(0, 7), 110, y + 19); g.restore();
            const rep = sr.d.replies[i];
            if(rep && (i < game - 2 || (i === game - 2 && e > 900))){
              const ok = rep === 'はい！いけます！';
              g.save(); g.fillStyle = ok ? '#5DFF8A' : '#9aa0b0'; rrPath(g, 184, y + 2, 128, 22, 11); g.fill();
              g.fillStyle = ok ? '#0a3a1a' : '#2a2a3a'; g.font = 'bold 9.5px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
              g.fillText(rep, 248, y + 13); g.restore();
            } else if(i === game - 2){ g.save(); g.fillStyle = '#fff'; g.font = 'bold 10px sans-serif'; g.fillText('…'.repeat(1 + Math.floor(e/250) % 3), 196, y + 15); g.restore(); }
          }
        }
      }

      if(sr.type === 'carriage'){
        g.fillStyle = '#FFF3B0'; g.beginPath(); g.arc(270, 40, 14, 0, 6.283); g.fill();
        for(let k=0;k<20;k++){ g.fillStyle = 'rgba(255,255,255,.6)'; g.fillRect((k*53) % W, 30 + (k*29) % 60, 1.5, 1.5); }
        g.fillStyle = '#0a1a3a'; g.fillRect(0, 136, W, 24);
        const cx = -60 + Math.min(1, e/2600)*(W + 120);
        drawCarriage(cx, 136);
        const ok = sr.d.at === game, jumpT = 1300;
        let kx = cx - 70 + Math.min(1, e/jumpT)*30, ky = 158, pose = 14;
        if(e > jumpT){ const jk = Math.min(1, (e - jumpT)/400);
          if(ok){ kx = cx - 40 + jk*30; ky = 158 - Math.sin(jk*Math.PI)*40 - jk*12; pose = 2; if(jk >= 1){ kx = cx; ky = 128; } }
          else { kx = cx - 50; ky = 158 - Math.sin(Math.min(1, jk*1.4)*Math.PI)*30; pose = 10; } }
        if(!(ok && e > jumpT + 400)) drawHeroSprite(pose, kx, ky, 60);
        if(e > jumpT + 500) bText(ok ? '乗り込み成功!!' : `乗り遅れた…${sr.len - game > 0 && !ok ? `（あと${sr.len - game}回）` : ''}`, 64, ok ? 18 : 13, ok ? '#FFE14D' : '#cfd8ff');
        g.save(); g.fillStyle = 'rgba(0,0,0,.5)'; rrPath(g, 8, 40, 66, 14, 7); g.fill(); g.fillStyle = '#FFE14D'; g.font = 'bold 8px "M PLUS 1p", sans-serif'; g.textBaseline = 'middle'; g.fillText(`チャンス ${game}/5`, 14, 47); g.restore();
      }

      if(sr.type === 'family'){
        const target = sr.d.counts[game - 1], prev = game > 1 ? sr.d.counts[game - 2] : 0;
        const n = Math.min(target, prev + Math.floor(Math.max(0, e - 300)/180));
        drawHeroSprite(game === 3 && e > 2200 && n < 20 ? 4 : 9, 52, 158, 74);
        const AV = ['🐰','🐻','🐱','🐶','🐼','🦊','🐹','🐧','🐨','🐸','🐯','🐮','🐷','🐵','🐥','🦁','🐰','🐻','🐱','🐶'];
        for(let i=0;i<20;i++){ const x = 116 + (i % 5)*38, y = 50 + Math.floor(i/5)*24;
          g.save(); g.globalAlpha = i < n ? 1 : .2; g.font = '16px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(i < n ? AV[i] : '・', x, y); g.restore(); }
        g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; rrPath(g, 8, 40, 84, 16, 8); g.fill(); g.fillStyle = n >= 20 ? '#FFE14D' : '#fff'; g.font = 'bold 9.5px "M PLUS 1p", sans-serif'; g.textBaseline = 'middle';
        g.fillText(`ファミリー ${n}/20`, 15, 48); g.restore();
        if(game === 3 && e > 2200){ if(n >= 20) bText('ファミリー集結!!', 146, 16, '#FFE14D', '#7a2a00'); else speech(sr.d.line, 84, 120, 150); }
      }

      if(sr.type === 'house'){
        // 家
        const hx = 220, hy = 140;
        g.fillStyle = '#fff6e0'; g.fillRect(hx - 50, hy - 52, 100, 52);
        g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(hx - 60, hy - 50); g.lineTo(hx, hy - 90); g.lineTo(hx + 60, hy - 50); g.fill();
        g.fillStyle = '#7a4a2a'; g.fillRect(hx - 10, hy - 30, 20, 30); g.fillStyle = '#9fd8ff'; g.fillRect(hx - 40, hy - 40, 20, 16); g.fillRect(hx + 20, hy - 40, 20, 16);
        g.fillStyle = '#3a7a3a'; g.fillRect(0, hy, W, H - hy);
        drawHeroSprite(game === 3 && e > 1800 ? (sr.success ? 2 : 10) : 1, 60, 158, 74);
        g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; rrPath(g, 172, 42, 96, 16, 8); g.fill(); g.fillStyle = '#FFE14D'; g.font = 'bold 9.5px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(sr.d.price, 220, 50); g.restore();
        if(game === 1) speech('コウジ、家を買います！', 92, 60, 120);
        if(game === 2){ bText('住宅ローン審査中' + '・'.repeat(1 + Math.floor(e/300) % 3), 72, 13, '#fff', '#1a3a6a'); }
        if(game === 3 && e > 1200){
          const k = Math.min(1, (e - 1200)/250), ok = sr.success;
          g.save(); g.translate(220, 98); g.rotate(-.2); g.scale(2 - k, 2 - k); g.globalAlpha = k;
          g.strokeStyle = ok ? '#e0102a' : '#3a3a8a'; g.lineWidth = 4; g.beginPath(); g.arc(0, 0, 26, 0, 6.283); g.stroke();
          g.fillStyle = g.strokeStyle; g.font = '900 18px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ok ? '承認' : '否決', 0, 1); g.restore();
          if(e > 1800) bText(ok ? '購入決定!!' : '家は買えませんでした…', 64, ok ? 18 : 12, ok ? '#FFE14D' : '#fff', '#1a3a6a');
        }
      }

      if(sr.type === 'hashiguchi'){
        g.fillStyle = '#4a3a2a'; g.fillRect(200, 52, 70, 98);   // ドア
        const open = Math.min(1, Math.max(0, (e - 600)/500));
        g.fillStyle = '#fff6d0'; g.fillRect(200, 52, 70*open, 98);
        drawHeroSprite(9, 64, 158, 74);
        // 何人目か
        g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; rrPath(g, 8, 40, 64, 14, 7); g.fill(); g.fillStyle = '#FFE14D'; g.font = 'bold 8px "M PLUS 1p", sans-serif'; g.textBaseline = 'middle'; g.fillText(`${game}人目`, 14, 47); g.restore();
        if(e < 1900) bText('ドアの向こうに誰か…', 64, 12, '#fff', '#000');
        if(e > 1200 && e < 1900){ g.save(); g.font = '60px sans-serif'; g.textAlign = 'center'; g.filter = 'brightness(0)'; g.fillText('🧑', 235, 125); g.restore(); }
        if(e >= 1900){
          const hashi = sr.success && game === 3;   // 橋口（女性）は3人目にだけ現れる
          g.save(); g.font = '60px sans-serif'; g.textAlign = 'center'; g.fillText(hashi ? '👩' : '🤢', 235, 125); g.restore();
          g.save(); g.fillStyle = hashi ? '#FFE14D' : '#7a8a3a'; rrPath(g, 205, 132, 60, 14, 7); g.fill(); g.fillStyle = '#000'; g.font = 'bold 8.5px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(hashi ? '橋口' : 'ゲボリスナー', 235, 139); g.restore();
          if(hashi){ bText('なんだ橋口か', 64, 18, '#fff', '#000'); }
          else { bText('ゲボリスナー登場！', 64, 14, '#c8ff6a', '#2a3a00'); if(e > 2600) speech('帰れ', 96, 82, 60); }
        }
      }

      // 結果の見出し
      if(R){
        const k = Math.min(1, re/200);
        const label = R.outcome === 'big' ? 'ボーナス！ボーナス！' : R.outcome === 'battle' ? 'バトル発展!!' : R.outcome === 'cz' ? 'チャンスステージへ!!' : null;
        if(label){ g.save(); g.fillStyle = `rgba(0,0,0,${.45*k})`; g.fillRect(0,0,W,H); g.restore();
          g.save(); g.translate(W/2, 86); g.scale(.6 + .4*easeBack(k), .6 + .4*easeBack(k)); g.translate(-W/2, -86);
          bText(label, 86, 22, R.outcome === 'big' ? `hsl(${(t/3)%360},100%,62%)` : '#FFE14D', '#2a0018'); g.restore(); }
      }
    }

    // ほかのプレイヤーのお知らせ：液晶上部を右から左へ流れる帯
    function drawBroadcast(t){
      if(!S.bcur && S.bq.length){ S.bcur = S.bq.shift(); S.bT = t; }
      if(!S.bcur) return;
      g.setTransform(scale,0,0,scale,0,0);
      g.save();
      g.font = '900 12px "M PLUS 1p", sans-serif';
      const tw = g.measureText(S.bcur).width, D = Math.max(5000, (W + tw) * 14);
      const e = t - S.bT;
      if(e > D){ S.bcur = null; g.restore(); return; }
      const a = Math.min(1, e/200, (D - e)/300);
      g.globalAlpha = a;
      const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, 'rgba(120,0,40,.88)'); gr.addColorStop(.5, 'rgba(200,20,60,.92)'); gr.addColorStop(1, 'rgba(120,0,40,.88)');
      g.fillStyle = gr; g.fillRect(0, 22, W, 20);
      g.fillStyle = '#FFE14D'; g.fillRect(0, 22, W, 1.5); g.fillRect(0, 40.5, W, 1.5);
      const x = W - (e / D) * (W + tw + 20);
      g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineWidth = 3; g.strokeStyle = '#3a0010';
      g.strokeText(S.bcur, x, 32.5); g.fillStyle = '#fff'; g.fillText(S.bcur, x, 32.5);
      g.restore();
    }

    // 前兆ステージ：夜のような紫の空気、流れ星、ざわつくコメント、増える視聴者
    function drawZen(t){
      const e = t - S.zenT;
      g.save();
      g.fillStyle = `rgba(60,0,110,${.12 + .05*Math.sin(t/400)})`; g.fillRect(0,0,W,H);
      const vg = g.createRadialGradient(W/2, H/2, 60, W/2, H/2, 200); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(90,0,140,.38)');
      g.fillStyle = vg; g.fillRect(0,0,W,H);
      for(let k=0;k<3;k++){ const p = ((t/1400 + k*.33) % 1); g.strokeStyle = `rgba(255,255,255,${.6*(1-p)})`; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(W*(1 - p) + 40, 20 + k*18 + p*30); g.lineTo(W*(1 - p) + 70, 12 + k*18 + p*30); g.stroke(); }
      g.restore();
      S.viewers += .6;
      if(Math.random() < .012) comment(pick(['なんか来そう', '空気変わった？', 'ざわざわ…', '前兆きた？', 'BGM変わった？', 'ドキドキ']), pick(VIEWERS));
    }
    function drawHiki(t){
      g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; rrPath(g, W - 112, 40, 104, 15, 7); g.fill();
      g.fillStyle = `hsl(${(t/4)%360},100%,70%)`; g.font = 'bold 8.5px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(`引き戻しチャンス 残り${S.hiki}G`, W - 60, 47.5); g.restore();
    }
    // 店員アシスト中のバッジ
    function drawStaffBadge(t){
      g.save(); g.textBaseline = 'middle';
      const p = 1 + .05*Math.sin(t/150);
      g.translate(W - 62, 140); g.scale(p, p);
      g.fillStyle = '#FFE14D'; g.strokeStyle = '#4a2a00'; g.lineWidth = 2;
      rrPath(g, -56, -11, 112, 22, 11); g.fill(); g.stroke();
      g.fillStyle = '#4a2a00'; g.font = '900 10px "M PLUS 1p", sans-serif'; g.textAlign = 'center';
      g.fillText('🙋 店員アシスト中', 0, 1);
      g.restore();
    }

    // ステージ切り替えのワイプ
    function drawStageWipe(t){
      const e = t - S.stageT, D = 900;
      if(e < 0 || e > D) return;
      const k = e/D, x = -W*.6 + k*W*2.2;
      g.save();
      g.fillStyle = S.stg === 3 ? '#C98A06' : S.stg === 2 ? '#6a2aff' : '#FF4F8B';
      g.beginPath(); g.moveTo(x - 120, 0); g.lineTo(x + 40, 0); g.lineTo(x - 20, H); g.lineTo(x - 180, H); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x + 44, 0); g.lineTo(x + 56, 0); g.lineTo(x - 4, H); g.lineTo(x - 16, H); g.fill();
      const a = Math.min(1, Math.min(e, D - e)/180);
      g.globalAlpha = a; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '900 24px "M PLUS 1p", sans-serif';
      g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = '#1a0020'; g.strokeText('STAGE CHANGE', W/2, H/2);
      g.fillStyle = '#fff'; g.fillText('STAGE CHANGE', W/2, H/2);
      g.restore();
    }

    // チャンスステージ：継続ジャッジ（残り5G）の煽りと結果
    function drawCZJudge(t){
      if(!S.cz || S.cz.left > 5) return;
      const strong = S.czAori === 'strong';
      g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
      const pulse = 1 + .05*Math.sin(t/(strong ? 90 : 200));
      g.translate(W/2, 30); g.scale(pulse, pulse);
      const gr = g.createLinearGradient(-90, 0, 90, 0);
      if(strong){ gr.addColorStop(0, '#FF2D2D'); gr.addColorStop(.5, '#FFB000'); gr.addColorStop(1, '#FF2D2D'); }
      else { gr.addColorStop(0, '#2a3a9a'); gr.addColorStop(1, '#5a2aaa'); }
      g.fillStyle = gr; rrPath(g, -92, -12, 184, 24, 12); g.fill();
      g.lineWidth = 2; g.strokeStyle = strong ? '#FFF3B0' : '#9FB8FF'; g.stroke();
      g.fillStyle = '#fff'; g.font = '900 11px "M PLUS 1p", sans-serif';
      g.fillText(`継続ジャッジ　あと ${S.cz.left}G`, 0, 1);
      g.restore();
      // 煽りの文字（ゲーム開始時に出る）
      const e = t - S.czAoriT;
      if(e >= 0 && e < 1600){
        const k = Math.min(1, e/200), out = e > 1300 ? (1600 - e)/300 : 1;
        g.save(); g.globalAlpha = out; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.translate(W/2, 64); g.scale(.6 + .4*easeBack(k), .6 + .4*easeBack(k));
        g.font = '900 20px "M PLUS 1p", sans-serif'; g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = strong ? '#5a0000' : '#0a1040';
        const txt = strong ? pick2(['いける…！','流れキテる！','まだ終わらない！'], S.czAoriSeed) : pick2(['まだまだ…','どうなる…','ドキドキ…'], S.czAoriSeed);
        g.strokeText(txt, 0, 0); g.fillStyle = strong ? '#FFE14D' : '#CFE0FF'; g.fillText(txt, 0, 0);
        g.restore();
        if(strong && Math.random() < .4) S.pfx.push({k:'fire', x:Math.random()*W, y:H, vx:0, vy:-2 - Math.random()*2, life:1, s:3 + Math.random()*4});
      }
    }
    function drawCZResult(t){
      const e = t - S.czResT;
      if(e < 0 || e > 2000 || !S.czResOk) return;
      const k = Math.min(1, e/220), out = e > 1700 ? (2000 - e)/300 : 1;
      g.save(); g.globalAlpha = out;
      g.fillStyle = 'rgba(90,0,60,.5)'; g.fillRect(0,0,W,H);
      g.save(); g.translate(W/2, H/2); g.rotate(t/1200);
      for(let i=0;i<16;i++){ g.rotate(Math.PI/8); g.fillStyle = i%2 ? 'rgba(255,225,77,.3)' : 'rgba(255,79,139,.25)'; g.beginPath(); g.moveTo(0,0); g.lineTo(220,-26); g.lineTo(220,26); g.fill(); }
      g.restore();
      g.translate(W/2, H/2); g.scale(.5 + .5*easeBack(k), .5 + .5*easeBack(k));
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.font = '900 34px "M PLUS 1p", sans-serif'; g.lineWidth = 8; g.strokeStyle = '#4a0020';
      g.strokeText('継続!!', 0, -6); g.fillStyle = '#FFE14D'; g.fillText('継続!!', 0, -6);
      g.font = '900 13px "M PLUS 1p", sans-serif'; g.lineWidth = 4; g.strokeText(`+${CZ_GAMES}G`, 0, 24); g.fillStyle = '#fff'; g.fillText(`+${CZ_GAMES}G`, 0, 24);
      g.restore();
    }
    const pick2 = (a, seed) => a[seed % a.length];

    // --- チャンスステージ ---
    const POSE = {
      idle:  [0, 2, 4, 6, 8, 11, 15],   // 決めポーズ・サングラス・後ろ姿など
      happy: [1, 7, 13, 14, 3],         // 両手を広げる・笑顔・乾杯・ピース・歌う
      love:  [5, 9],                    // ハート
      sad:   [12],                      // 叫び・汗
      look:  [10, 6]                    // 前のめり・振り返り
    };
    function setPose(kind){ const a = POSE[kind]; let p; do { p = pick(a); } while(a.length > 1 && p === S.pose); S.pose = p; S.poseT = performance.now(); }
    function drawCZ(t){
      // 背景：夜景をゆっくり左右にパン
      if(CZ_BG.complete && CZ_BG.naturalWidth){
        const bw = CZ_BG.naturalWidth * H / CZ_BG.naturalHeight;
        const ox = (Math.sin(t/16000) * .5 + .5) * (bw - W);
        g.drawImage(CZ_BG, -ox, 0, bw, H);
      } else { g.fillStyle = '#1a2a8a'; g.fillRect(0,0,W,H); }
      const vg = g.createLinearGradient(0, 0, 0, H); vg.addColorStop(0, 'rgba(10,0,40,.25)'); vg.addColorStop(.6, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(20,0,40,.45)');
      g.fillStyle = vg; g.fillRect(0,0,W,H);
      // 舞い上がる光
      for(let k=0;k<14;k++){ const x = (k*53 + t/30) % W, y = H - ((t/18 + k*37) % H); g.globalAlpha = .5; g.fillStyle = k%2 ? '#FFE38A' : '#FFB3E6'; g.fillRect(x, y, 1.6, 1.6); }
      g.globalAlpha = 1;
      // キャラ（ポーズを切り替えながら弾む）
      if(t - S.poseT > 2600 && S.mode !== 'spin') setPose('idle');
      if(CZ_SPRITES.complete && CZ_SPRITES.naturalWidth){
        const pe = t - S.poseT, pop = pe < 240 ? 1 + .05*Math.sin(pe/240*Math.PI) : 1;
        const beat = t/1000*132/60, hop = Math.abs(Math.sin(beat*Math.PI))*3;
        const sz = spriteSize(CZ_SPRITES, S.pose, 122, 210), dw = sz.w*pop, dh = sz.h*pop;
        g.save(); g.translate(160, 162 - hop); g.rotate(Math.sin(beat*Math.PI)*.04);
        g.drawImage(CZ_SPRITES, sz.b.x, sz.b.y, sz.b.w, sz.b.h, -dw/2, -dh, dw, dh); g.restore();
      }
      // 残りゲーム数（継続ジャッジ中はジャッジ表示に切り替え）
      if(S.cz && S.cz.left > 5){
        g.save(); g.textBaseline = 'middle';
        const gr = g.createLinearGradient(W - 96, 0, W - 6, 0); gr.addColorStop(0, '#FF2D78'); gr.addColorStop(1, '#9B5CFF');
        g.fillStyle = gr; rrPath(g, W - 98, 23, 92, 16, 8); g.fill();
        g.fillStyle = '#fff'; g.font = 'bold 8.5px "M PLUS 1p", sans-serif'; g.textAlign = 'left'; g.fillText('CHANCE', W - 92, 31);
        g.textAlign = 'right'; g.font = 'bold 10px "M PLUS 1p", sans-serif'; g.fillText(`残り${S.cz.left}G`, W - 10, 31);
        g.restore();
      }
    }
    // 突入・終了の告知
    function drawCZBanner(t){
      const ei = t - S.czT, eo = t - S.czEndT;
      const e = Math.min(ei, eo), entering = ei <= eo, D = entering ? 1800 : 1400;
      if(e < 0 || e > D) return;
      const k = Math.min(1, e/220), out = e > D - 250 ? (D - e)/250 : 1;
      g.save(); g.globalAlpha = out;
      g.fillStyle = entering ? 'rgba(60,0,60,.55)' : 'rgba(0,0,30,.55)'; g.fillRect(0,0,W,H);
      if(entering){ g.save(); g.translate(W/2, H/2); g.rotate(t/1500);
        for(let i=0;i<16;i++){ g.rotate(Math.PI/8); g.fillStyle = i%2 ? 'rgba(255,215,90,.25)' : 'rgba(255,90,190,.2)'; g.beginPath(); g.moveTo(0,0); g.lineTo(220,-24); g.lineTo(220,24); g.fill(); }
        g.restore(); }
      g.translate(W/2, H/2); g.scale(.6 + .4*easeBack(k), .6 + .4*easeBack(k));
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.font = '900 13px "M PLUS 1p", sans-serif'; g.lineWidth = 4; g.strokeStyle = '#2a0030';
      g.strokeText('CHANCE STAGE', 0, -22); g.fillStyle = '#FFE14D'; g.fillText('CHANCE STAGE', 0, -22);
      g.font = '900 26px "M PLUS 1p", sans-serif'; g.lineWidth = 7;
      const txt = entering ? 'チャンスステージ突入！' : 'チャンスステージ終了';
      g.strokeText(txt, 0, 6); g.fillStyle = entering ? '#fff' : '#cfd8ff'; g.fillText(txt, 0, 6);
      g.restore();
    }

    // --- AT：イベント配信モード ---
    // 777ボーナス：Machida Universe のライブ会場で、覚醒町田さんがギター・炎の剣で魅せる
    const MPOSE = {
      idle:  [0, 1, 3, 7, 9, 13, 14, 16, 17, 22, 4, 10],
      play:  [2, 8, 18, 24, 5],                 // ギター
      fire:  [6, 12, 15, 19, 21, 23],           // 炎の剣
      happy: [3, 11, 20, 8]                     // ピース・笑顔・ガッツポーズ
    };
    const MPOSE_FX = {6:'fire', 12:'fire', 15:'fire', 19:'fire', 21:'fire', 23:'fire', 2:'notes', 8:'notes', 18:'notes', 24:'notes', 5:'notes', 20:'confetti', 11:'hearts', 3:'sparkle'};
    function machidaPose(cat, t){
      const list = MPOSE[cat]; let p; do { p = pick(list); } while(list.length > 1 && p === S.mp);
      S.mp = p; S.mpCat = cat; S.mpT = t;
    }
    function drawUniverse(t){
      if(atvReady() && S.at && S.at.type === 'S7'){
        g.drawImage(ATV, 0, 0, W, H);
        const vg = g.createLinearGradient(0, 100, 0, H); vg.addColorStop(0, 'rgba(10,0,40,0)'); vg.addColorStop(1, 'rgba(10,0,40,.45)');
        g.fillStyle = vg; g.fillRect(0, 100, W, H - 100);   // 下端の進捗バーを見やすく
        return;
      }
      if(UNIV_BG.complete && UNIV_BG.naturalWidth){
        // ゆっくりズームしながら左右に流す
        const z = 1.08 + .05*Math.sin(t/7000), bw = W*z, bh = H*z;
        const ox = (W - bw)/2 + Math.sin(t/9000)*8, oy = (H - bh)/2;
        g.drawImage(UNIV_BG, ox, oy, bw, bh);
      } else { g.fillStyle = '#1a1a6a'; g.fillRect(0,0,W,H); }
      // ステージライトの明滅と、手前を少し暗くして主役を目立たせる
      g.save(); g.globalAlpha = .12 + .08*Math.sin(t/300); g.fillStyle = '#9fd8ff'; g.fillRect(0,0,W,H); g.restore();
      const vg = g.createLinearGradient(0, 70, 0, H); vg.addColorStop(0, 'rgba(10,0,40,0)'); vg.addColorStop(1, 'rgba(10,0,40,.55)');
      g.fillStyle = vg; g.fillRect(0, 70, W, H - 70);
      for(let k=0;k<8;k++){ const x = (k*47 + t/25) % W, y = 10 + (k*31) % 60; g.globalAlpha = .5 + .5*Math.sin(t/200 + k); sparkle(x, y, 2 + k%3, '#fff'); }
      g.globalAlpha = 1;
    }
    function drawMachida(t){
      const spin = S.mode === 'spin', gained = S.gain > 0 && t - S.gainT < 1400;
      const cat = gained ? 'happy' : spin ? (Math.floor(t/2600) % 2 ? 'fire' : 'play') : 'idle';
      if(S.mp === undefined || S.mpCat !== cat || (cat === 'idle' && t - S.mpT > 3200)) machidaPose(cat, t);
      if(!(MACHIDA.complete && MACHIDA.naturalWidth)) return;
      const sz = spriteSize(MACHIDA, S.mp, 122, 220), pe = t - S.mpT;
      const pop = pe < 240 ? 1 + .05*Math.sin(pe/240*Math.PI) : 1;
      const beat = t/1000*132/60, rot = Math.sin(beat*Math.PI)*.03, hop = cat === 'happy' ? Math.abs(Math.sin(t/150))*8 : Math.abs(Math.sin(beat*Math.PI))*2;
      const tag = MPOSE_FX[S.mp];
      if(tag === 'fire'){ g.save(); g.globalAlpha = .35 + .2*Math.sin(t/60); const fg = g.createRadialGradient(W/2, 110, 10, W/2, 110, 120);
        fg.addColorStop(0, 'rgba(255,160,40,.9)'); fg.addColorStop(1, 'rgba(255,60,0,0)'); g.fillStyle = fg; g.fillRect(0,0,W,H); g.restore(); }
      const dw = sz.w*pop, dh = sz.h*pop;
      g.save(); g.translate(W/2, 158 - hop); g.rotate(rot);
      g.shadowColor = tag === 'fire' ? 'rgba(255,140,40,.9)' : 'rgba(180,220,255,.8)'; g.shadowBlur = 16;
      g.drawImage(MACHIDA, sz.b.x, sz.b.y, sz.b.w, sz.b.h, -dw/2, -dh, dw, dh); g.restore();
      if(tag) poseFx(tag, t, W/2, 158 - dh, dh);
      drawPoseFx();
    }

    function drawAT(t){
      if(S.at.type === 'S7'){ drawUniverse(t); drawATHud(t); if(!atvReady() && (!S.navi || S.mode !== 'spin')) drawMachida(t); drawGisi(t); drawATGain(t); return; }
      const sk = g.createLinearGradient(0,0,0,H);
      sk.addColorStop(0,'#3a0a5a'); sk.addColorStop(1,'#b0145a');
      g.fillStyle = sk; g.fillRect(0,0,W,H);
      g.save(); g.translate(W/2, 150); g.rotate(t/3000);
      for(let k=0;k<16;k++){ g.rotate(Math.PI/8); g.fillStyle = k%2 ? 'rgba(255,215,90,.10)' : 'rgba(255,120,200,.09)';
        g.beginPath(); g.moveTo(0,0); g.lineTo(260,-30); g.lineTo(260,30); g.fill(); }
      g.restore();
      drawATHud(t);
      if(S.navi && S.mode === 'spin'){ drawHeroine(t, W/2, 154, 52); }
      else { drawHeroine(t, W/2, 156, 104, S.gain > 0 && t - S.gainT < 900 ? 'happy' : 'dance'); }
      drawGisi(t);
      drawATGain(t);
    }
    // ボーナス中の残り枚数：左上の小さなピル＋細い進捗バー（動画のじゃまにならないように）
    function drawATHud(t){
      const at = S.at, left = Math.max(0, at.goal - at.paid), last = left <= 30;
      g.save(); g.textBaseline = 'middle';
      g.fillStyle = 'rgba(10,0,30,.55)'; rrPath(g, 6, 22, 70, 17, 8.5); g.fill();
      g.lineWidth = 1; g.strokeStyle = last ? `hsl(${(t/3)%360},100%,65%)` : 'rgba(242,193,78,.7)'; g.stroke();
      g.textAlign = 'left'; g.fillStyle = last ? '#FFB0D0' : 'rgba(255,255,255,.8)'; g.font = 'bold 7px "M PLUS 1p", sans-serif';
      g.fillText('残り', 12, 31);
      const gr = g.createLinearGradient(0, 24, 0, 38); gr.addColorStop(0, '#FFFBE6'); gr.addColorStop(1, '#FFC23A');
      g.textAlign = 'right'; g.font = '14px DotGothic16, monospace'; g.lineWidth = 2.5; g.strokeStyle = 'rgba(30,0,20,.8)';
      g.strokeText(left, 64, 31.5); g.fillStyle = gr; g.fillText(left, 64, 31.5);
      g.textAlign = 'left'; g.font = 'bold 6.5px "M PLUS 1p", sans-serif'; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText('枚', 66, 32);
      g.restore();
      // 進捗バー（下端・細め）
      const rate = Math.min(1, at.paid / at.goal), bw = W - 12;
      g.save(); g.fillStyle = 'rgba(0,0,0,.35)'; rrPath(g, 6, H - 6, bw, 3, 1.5); g.fill();
      const pg = g.createLinearGradient(6, 0, 6 + bw, 0); pg.addColorStop(0, '#FF4F8B'); pg.addColorStop(.5, '#FFD23A'); pg.addColorStop(1, '#5DFF8A');
      g.fillStyle = pg; rrPath(g, 6, H - 6, Math.max(3, bw*rate), 3, 1.5); g.fill();
      g.restore();
    }
    function drawATGain(t){
      // 上乗せ
      const ae = t - S.atAddT;
      if(ae < 1700){
        const k = Math.min(1, ae/200), out = ae > 1400 ? (1700 - ae)/300 : 1;
        g.save(); g.globalAlpha = out; g.translate(W/2, 62); g.scale(.6 + .4*easeBack(k), .6 + .4*easeBack(k));
        g.font = '900 20px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
        g.lineWidth = 6; g.strokeStyle = '#2a0018'; g.strokeText(`上乗せ +${S.atAddV}枚!!`, 0, 0);
        g.fillStyle = `hsl(${(t/3)%360},100%,62%)`; g.fillText(`上乗せ +${S.atAddV}枚!!`, 0, 0); g.restore();
      }
      // 特化ゾーン
      if(S.at && S.at.zone > 0){
        g.save(); g.fillStyle = 'rgba(80,0,20,.75)'; rrPath(g, W - 128, 40, 120, 16, 8); g.fill();
        g.strokeStyle = '#FF9A2E'; g.lineWidth = 1.5; g.shadowColor = '#FF5A00'; g.shadowBlur = 10; g.stroke(); g.shadowBlur = 0;
        g.fillStyle = '#FFE14D'; g.font = 'bold 8.5px "M PLUS 1p", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(`🔥ギター覚醒タイム 残り${S.at.zone}G`, W - 68, 48); g.restore();
      }
      const ze = t - S.zoneT;
      if(ze < 1800){ g.save(); g.globalAlpha = ze > 1500 ? (1800 - ze)/300 : 1; g.fillStyle = 'rgba(255,90,0,.25)'; g.fillRect(0,0,W,H);
        bText('ギター覚醒タイム突入!!', 82, 18, '#FFE14D', '#5a1000'); g.restore(); }
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
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none'; g.shadowBlur = 0;
      // 自然に流れるコメントとハート
      const hype = S.mode === 'spin' && S.scene !== 'walk';
      if(!S.tenpai && t > S.nextCom){
        if(S.at && S.mode !== 'atEnd'){
          // ボーナス中はライブ会場のような盛り上がりコメント
          S.nextCom = t + rnd(450, 900);
          const pool = (S.at.type === 'S7' ? LIVE_TALK.concat(LIVE_TALK_777) : LIVE_TALK).filter(x => !(S.liveRecent || []).includes(x));
          const txt = pick(pool); S.liveRecent = [txt, ...(S.liveRecent || [])].slice(0, 6);   // 直近と同じ言葉が続かないように
          const l = pick(LISTENERS); comment(txt, [l.av, l.name]);
        } else {
          S.nextCom = t + (hype ? rnd(350, 600) : rnd(1100, 2200));
          if(hype) comment(pick(TALK.hype));
          else { const l = pick(CALM_LISTENERS); comment(l.text, [l.av, l.name]); }
        }
      }
      if(t > S.nextHeart){ S.nextHeart = t + (hype ? 180 : rnd(700, 1400)); hearts(1); }
      S.viewers += (hype ? .6 : .02) * (Math.random() - .3);

      if(S.mode === 'atEnd'){
        if(S.endInfo && S.endInfo.type === 'S7'){ drawUniverse(t); S.gain = 1; S.gainT = t; drawMachida(t); S.gain = 0; }   // 777ボーナスの終了画面
        else { drawRoom(t); drawFloor(); drawHeroine(t, W/2, 156, 110, 'happy'); drawMic(); }
        drawGisi(t);
        g.fillStyle = 'rgba(40,0,40,.45)'; g.fillRect(0,0,W,H);
        drawText('EVENT CLEAR', 50, 24, '#fff3b0');
        g.save(); g.textAlign = 'center'; g.font = 'bold 14px "M PLUS 1p", sans-serif'; g.fillStyle = '#fff';
        g.fillText(`獲得 ${S.endInfo.paid}枚`, W/2, 76); g.restore();
        drawUI(t); return;
      }
      if(S.at && S.mode !== 'big'){ drawAT(t); drawUI(t); if(S.cut) drawCutin(t); return; }
      if(S.mode === 'big'){
        // 揃った瞬間は確定ステージ（おじいちゃん）の背景のまま祝う
        drawConfirmStage(t);
        g.fillStyle = 'rgba(30,0,30,.25)'; g.fillRect(0,0,W,H);
        drawFireworks(t);
        drawBigWin(t);
        if(Math.random() < .08) comment(pick(TALK.win));
        if(Math.random() < .3) hearts(1, true);
        drawUI(t); return;
      }
      if(S.pv){ drawPreview(t); if(S.pv) return; }                          // 次回予告
      if(S.sr && !S.at){ drawSR(t); drawUI(t, S.sr.type !== 'hashiguchi'); return; }   // 特殊リーチ
      if(S.bt && !S.at){ drawBattle(t); drawUI(t, true); if(S.cut) drawCutin(t); return; }   // バトル中はコメント欄を出さない
      if(S.tenpai){ drawTenpai(t); drawUI(t); if(S.cut) drawCutin(t); return; }
      // 大当たり確定（図柄告知中）は専用ステージに固定
      if(S.aim){ drawConfirmStage(t); drawUI(t); drawAimBanner(t); if(S.staff) drawStaffBadge(t); if(S.cut) drawCutin(t); return; }

      if(!S.cz) drawStageBg(t);
      const sc = S.scene;
      // キャラの表情
      let mood = (t - S.talkT) % 5200 < 1600 ? 'talk' : 'idle';
      if(S.mode === 'spin' && sc !== 'walk') mood = 'look';
      if(S.mode === 'result' && S.result){
        const r = S.result;
        if(r.flag && r.hit && r.flag !== 'RPL') mood = 'happy';
        if(r.big) mood = 'happy';
        else if((sc === 'hokuto' || sc.startsWith('chest')) && !(r.flag && sc.startsWith('chest'))) mood = 'sad';
      }
      if(t - S.shockT < 1500) mood = 'shock';
      if(t - S.jumpT < 900) mood = 'happy';
      if(S.cz) drawCZ(t);
      else if(S.stg === 1){ drawFloor(); drawStageChar(t, mood); drawMic(); }
      else drawStageChar(t, mood);

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
      if(S.zen && !S.cz) drawZen(t);
      if(S.hiki > 0 && !S.cz) drawHiki(t);
      if(S.cz) drawCZJudge(t);
      drawCZResult(t);
      drawCZBanner(t);
      if(!S.cz) drawStageWipe(t);
      if(S.cut) drawCutin(t);
      if(S.mode === 'idle' && !S.aim && !S.cz && Math.floor(t/700) % 2) drawText('PRESS SPIN', 17, 11, '#fff', '#ff2d55');
    }
    let lastErr = 0;
    function loop(t){
      requestAnimationFrame(loop);
      if(document.hidden) return;
      try { frame(t); drawReveal(t); drawBroadcast(t); }
      catch(err){ if(t - lastErr > 5000){ console.error(err); lastErr = t; } g.restore(); g.globalAlpha = 1; }
    }

    return {
      resize,
      tenpai(on){ S.tenpai = on; S.tenpaiT = performance.now(); S.nico = []; },
      setAT(at){ S.at = at; },
      startAT(navi){ Object.assign(S, {mode:'spin', scene:'walk', navi, stage:0, tenpai:false, gain:0, gisi:0, cut:null}); },
      resultAT(gain){ Object.assign(S, {mode:'result', gain, gainT:performance.now()}); if(gain > 0){ hearts(4); comment(pick(TALK.win)); } },
      atEnd(info){ Object.assign(S, {mode:'atEnd', at:null, endInfo:info}); },
      react(){ S.shockT = performance.now(); comment('えっ!?', pick(VIEWERS)); },
      start(scene){
        if(S.cz) setPose(scene === 'walk' ? 'idle' : 'look');
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
        if(S.scene === 'hokuto') (result.big ? sfx.hokutoWin : sfx.hokutoFail)();
        if(S.cz) setPose(result.hit && result.flag && result.flag !== 'RPL' ? (Math.random() < .3 ? 'love' : 'happy') : (S.scene !== 'walk' ? 'sad' : 'idle'));
        if(result.hit && result.flag && result.flag !== 'RPL'){ S.jumpT = performance.now(); hearts(6); comment(pick(TALK.win)); }
        else if(S.scene !== 'walk' && !result.hit){
          // 期待させてハズレたときは辛口リスナーが反応することも
          if(Math.random() < .5){ const l = pick(SALTY_LISTENERS); comment(l.text, [l.av, l.name]); } else comment(pick(TALK.lose));
        }
      },
      big(key){ Object.assign(S, {mode:'big', bigKey:key, fireworks:[], nextFw:0, tenpai:false}); hearts(20, true); },
      idle(){ S.mode = 'idle'; S.scene = 'walk'; },
      get mode(){ return S.mode; },
      setAim(key){ S.aim = key; },
      setLucky(on){ S.lucky = on; },
      setPlayers(n){ S.players = n; },
      broadcast(text){ S.bq.push(text); comment(text, ['📣', 'お知らせ']); },
      srStart(sr){ S.sr = JSON.parse(JSON.stringify(sr)); S.srT = performance.now(); S.srRes = null; S.pickT = 0;
        comment(pick(['なにか始まった！', 'え、なになに？', 'これはアツい？']), pick(VIEWERS));
        this.srComments(sr); },
      srStep(sr){ if(!S.sr) return this.srStart(sr); S.sr = JSON.parse(JSON.stringify(sr)); S.srT = performance.now(); this.srComments(sr); },
      srComments(sr){
        if(sr.type !== 'hashiguchi') return;
        if(sr.success && sr.game === 3) for(let k=0;k<8;k++) setTimeout(() => comment('なんだ橋口か', pick(VIEWERS)), 1900 + k*160);   // 全員「なんだ橋口か」
        else setTimeout(() => comment(pick(['帰れｗ', 'また来たｗ', 'ゲボやん']), pick(VIEWERS)), 2700);
      },
      srPick(i){ if(S.sr){ S.sr.d.picked = i; S.pickT = performance.now(); } },
      srResult(sr){ if(!S.sr) S.sr = JSON.parse(JSON.stringify(sr)); S.srRes = sr; S.srResT = performance.now();
        if(sr.type === 'family' && !sr.success) comment('こわっ', pick(VIEWERS)); },
      srEnd(){ S.sr = null; S.srRes = null; },
      preview(pv){ S.pv = pv; S.pvT = performance.now(); S.pvRevealed = false; },
      reveal(pv){ S.rv = pv; S.rvT = performance.now(); S.pvRevealed = true; sfx.reveal(); },
      gisiFail(){ S.gfT = performance.now(); sfx.battleLose(); },
      battleStart(b, dev){ S.bDev = !!dev; S.bt = {...b, hp:b.hp.slice()}; S.bhpView = [100,100]; S.bAct = {type:'intro', t0:performance.now()}; S.bT = performance.now();
        comment(`${BATTLES[b.type].name}が始まった！`, pick(VIEWERS)); },
      battleRestore(b){ S.bt = {...b, hp:b.hp.slice()}; S.bhpView = b.hp.slice(); S.bAct = null; },
      battleAct(type, dmg, snap){ if(!S.bt) return; S.bAct = {type, dmg, snap, t0:performance.now()}; S.bt.game = state.battle ? state.battle.game : S.bt.game; },
      battleFinal(){ if(!S.bt) return; S.bt.game = 5; S.bAct = {type:'final', t0:performance.now()}; comment('最終決戦！', pick(VIEWERS)); },
      battleClash(){ if(S.bt) S.bAct = {type:'clash', t0:performance.now()}; },
      battleResult(win, comeback){ if(!S.bt) return; S.bAct = {type:'result', win, comeback, t0:performance.now()};
        if(win){ S.bt.hp = [S.bt.hp[0], 0]; S.bt.alive = 0; comment(comeback ? '逆転きたあああ！' : '勝ったー！', pick(VIEWERS)); hearts(16, true); }
        else { S.bt.hp = [0, S.bt.hp[1]]; comment(pick(['どんまい','おしい…','次は勝てる！']), pick(VIEWERS)); }
        setTimeout(() => { if(S.bAct && S.bAct.type === 'result') S.bt = null; }, win ? (comeback ? 2600 : 1800) : 2600); },
      battleEnd(){ S.bt = null; S.bAct = null; },
      battleUpgrade(b, text){ if(S.bt){ S.bt.type = b.type; S.bt.stars = b.stars; S.bt.rainbow = b.rainbow; S.bt.alive = b.alive; } S.bBanner = text; S.bBannerT = performance.now(); },
      setZen(z){ if(z && !S.zen) S.zenT = performance.now(); S.zen = z ? {...z} : null; },
      setHiki(n){ S.hiki = n; },
      atAdd(n){ S.atAddV = n; S.atAddT = performance.now(); comment(pick([`+${n}枚きたー！`, '上乗せうま！', 'まだ終わらせない！']), pick(VIEWERS)); },
      atZone(){ S.zoneT = performance.now(); comment('ギター覚醒タイムきたあああ！', pick(VIEWERS)); setTimeout(() => comment('ここ乗せまくれ！', pick(VIEWERS)), 500); },
      say(text, who){ comment(text, who); },
      setStaff(on){ S.staff = on; if(on) comment('店員さん来た！', pick(VIEWERS)); },
      setCZ(cz){ S.cz = cz ? {...cz} : null; },
      changeStage(n){ S.stg = n; S.stageT = performance.now(); S.np = null; comment('STAGE CHANGE!', pick(VIEWERS)); },
      setStage(n){ S.stg = n; S.np = null; },
      czAori(kind){ S.czAori = kind; S.czAoriT = performance.now(); S.czAoriSeed = Math.floor(Math.random()*99); setPose('look'); },
      czResult(ok){ S.czResOk = ok; S.czResT = performance.now(); if(ok){ setPose('happy'); hearts(20, true); comment('継続きたー！', pick(VIEWERS)); } },
      czStart(){ S.czT = performance.now(); setPose('happy'); comment('チャンスステージきた！', pick(VIEWERS)); },
      czEnd(){ S.czEndT = performance.now(); },
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
      try { step(t); } catch(err){ console.error(err); active = false; cv.hidden = true; }
    }
    function step(t){
      const r = cv.getBoundingClientRect(), w = r.width || innerWidth, h = r.height || innerHeight, u = Math.min(w, h);
      if(cv.width !== Math.round(w*dpr) || cv.height !== Math.round(h*dpr)){ cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr); }
      const e = t - t0;
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
  // 8-5. 大当たり確定の突入演出（全画面）：おじいちゃん背景に切り替わる前に入る
  //      虹の流れ星が横切る → おじいちゃんが飛び込む → 「ボーナス！ボーナス！」
  // ================================================================
  const kakutei = (() => {
    const cv = $('kakutei'), c = cv.getContext('2d');
    let active = false, t0 = 0, dur = 2800, dpr = 1, key = 'S7', onEnd = null, stars = [];
    const easeBack = x => 1 + 2.7*Math.pow(x-1,3) + 1.7*Math.pow(x-1,2);
    const easeOut = x => 1 - Math.pow(1 - x, 3);
    function start(k, cb){
      if(active){ cb && cb(); return; }
      key = k; onEnd = cb; dpr = Math.min(2, window.devicePixelRatio || 1);
      dur = reduceMotion ? 1500 : (k === 'S7' ? 3800 : 2800);
      conf = []; bursts = 0;
      stars = Array.from({length:40}, () => ({x:Math.random(), y:Math.random(), s:1 + Math.random()*2.5, ph:Math.random()*6}));
      active = true; t0 = performance.now(); cv.hidden = false;
      if(k === 'S7') sfx.kyuin777(); else sfx.kakutei();
      requestAnimationFrame(loop);
    }
    function finish(){ if(!active) return; active = false; cv.hidden = true; const f = onEnd; onEnd = null; f && f(); }
    function loop(t){
      try { if(step(t)) requestAnimationFrame(loop); else finish(); }
      catch(err){ console.error(err); finish(); }
    }
    // ---- 777確定の全画面：イラストを全面に、クラッカーと光のエフェクト ----
    let conf = [], bursts = 0;
    function cracker(w, h, u, fromLeft){
      const x = fromLeft ? 0 : w, y = h, base = fromLeft ? -Math.PI/3 : -Math.PI*2/3;
      for(let i=0;i<80;i++){
        const a = base + (Math.random()-.5)*.7, sp = u*(.022 + Math.random()*.03);
        conf.push({x, y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, r:Math.random()*6, vr:(Math.random()-.5)*.4,
          s:u*(.012 + Math.random()*.012), c:['#FF4F8B','#FFE14D','#4FF3FF','#9B5CFF','#5DFF8A','#fff','#FF9A2E'][i % 7], ribbon: i % 6 === 0, life:1});
      }
      sfx.cracker();
    }
    function step777(t, e, w, h, u){
      const D = dur;
      const fadeOut = e > D - 350 ? Math.max(0, (D - e)/350) : 1;
      c.globalAlpha = fadeOut;
      // 背景：イラストを画面いっぱいに（最初は大きく、すっと引く）
      const z = 1 + .18*Math.max(0, 1 - easeOut(Math.min(1, e/900))) + .015*Math.sin(e/700);
      const sc = Math.max(w / K777.naturalWidth, h / K777.naturalHeight) * z;
      const iw = K777.naturalWidth*sc, ih = K777.naturalHeight*sc;
      c.drawImage(K777, (w - iw)/2 + Math.sin(e/900)*u*.01, (h - ih)/2, iw, ih);
      // 光：上から差すスポットライトが左右に振れる（加算合成）
      c.save(); c.globalCompositeOperation = 'lighter';
      for(let i=0;i<6;i++){
        const x = w*(i + .5)/6, a = Math.sin(e/600 + i*1.3)*.5;
        c.save(); c.translate(x, -h*.05); c.rotate(a);
        const lg = c.createLinearGradient(0, 0, 0, h*1.1);
        lg.addColorStop(0, `hsla(${(i*60 + e/8) % 360},100%,75%,.45)`); lg.addColorStop(1, 'hsla(0,0%,100%,0)');
        c.fillStyle = lg; c.beginPath(); c.moveTo(-u*.02, 0); c.lineTo(u*.02, 0); c.lineTo(u*.16, h*1.1); c.lineTo(-u*.16, h*1.1); c.fill();
        c.restore();
      }
      // きらめき（レンズフレア風）
      for(let i=0;i<18;i++){
        const ph = (e/500 + i*.37) % 1, x = ((i*0.618) % 1)*w, y = ((i*0.381 + .1) % .8)*h, r = u*.03*Math.sin(ph*Math.PI);
        c.fillStyle = 'rgba(255,255,255,.9)'; c.beginPath();
        c.moveTo(x, y - r*2); c.quadraticCurveTo(x, y, x + r*2, y); c.quadraticCurveTo(x, y, x, y + r*2); c.quadraticCurveTo(x, y, x - r*2, y); c.quadraticCurveTo(x, y, x, y - r*2); c.fill();
      }
      c.restore();
      // ストロボ
      if(e > 200 && (e % 520) < 60){ c.fillStyle = 'rgba(255,255,255,.22)'; c.fillRect(0,0,w,h); }
      // クラッカー：左右の下から3回
      const plan = [300, 1200, 2200];
      while(bursts < plan.length && e >= plan[bursts]){ cracker(w, h, u, true); cracker(w, h, u, false); bursts++; }
      conf = conf.filter(p => p.life > 0 && p.y < h + 40);
      for(const p of conf){
        p.vy += u*.0006; p.vx *= .985; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life -= .004;
        c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.c;
        if(p.ribbon){ c.strokeStyle = p.c; c.lineWidth = p.s*.35; c.beginPath(); c.moveTo(-p.s*1.5, 0); c.bezierCurveTo(-p.s*.5, -p.s, p.s*.5, p.s, p.s*1.5, 0); c.stroke(); }
        else c.fillRect(-p.s/2, -p.s/4, p.s, p.s/2);
        c.restore();
      }
      // （文字は表示しない：イラストと光・クラッカーだけ）
      // 最初の白フラッシュ
      if(e < 220){ c.globalAlpha = 1 - e/220; c.fillStyle = '#fff'; c.fillRect(0,0,w,h); }
      c.globalAlpha = 1;
      return e < D;
    }
    function step(t){
      const r = cv.getBoundingClientRect(), w = r.width || innerWidth, h = r.height || innerHeight, u = Math.min(w, h);
      if(cv.width !== Math.round(w*dpr) || cv.height !== Math.round(h*dpr)){ cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr); }
      const e = t - t0;
      c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,w,h);
      if(key === 'S7' && K777.complete && K777.naturalWidth) return step777(t, e, w, h, u);
      const fadeIn = Math.min(1, e/150), fadeOut = e > dur - 300 ? Math.max(0, (dur - e)/300) : 1;
      c.globalAlpha = fadeIn * fadeOut;
      // 夜空から、金と赤の光へ変わる背景
      const bg = c.createRadialGradient(w/2, h*.6, 0, w/2, h*.55, Math.max(w,h)*.8);
      const warm = Math.min(1, Math.max(0, (e - 500)/400));
      bg.addColorStop(0, warm ? `rgba(255,232,140,${warm})` : '#2a1a6a'); bg.addColorStop(.4, warm ? '#FF8A1E' : '#1a0a4a'); bg.addColorStop(1, '#2a0010');
      c.fillStyle = '#0a0420'; c.fillRect(0,0,w,h);
      c.fillStyle = bg; c.fillRect(0,0,w,h);
      for(const s of stars){ c.fillStyle = `rgba(255,255,255,${.4 + .6*Math.abs(Math.sin(e/200 + s.ph))})`; c.fillRect(s.x*w, s.y*h, s.s, s.s); }
      if(warm > 0){ c.save(); c.globalAlpha *= warm; c.translate(w/2, h*.6); c.rotate(e/2200);
        for(let i=0;i<20;i++){ c.rotate(Math.PI/10); c.fillStyle = i%2 ? 'rgba(255,255,255,.18)' : 'rgba(255,215,90,.14)'; c.beginPath(); c.moveTo(0,0); c.lineTo(Math.max(w,h), -u*.08); c.lineTo(Math.max(w,h), u*.08); c.fill(); }
        c.restore(); }
      // 虹の流れ星が右上から左下へ横切る
      const se = e/600;
      if(se < 1.2){
        const x = w*(1.1 - se*1.2), y = h*(.05 + se*.45), len = u*.55;
        for(let i=0;i<7;i++){ c.strokeStyle = `hsla(${i*50},100%,65%,.75)`; c.lineWidth = u*.012; c.lineCap = 'round';
          c.beginPath(); c.moveTo(x + i*u*.006, y - i*u*.004); c.lineTo(x + len + i*u*.006, y - len*.38 - i*u*.004); c.stroke(); }
        c.save(); c.translate(x, y); c.rotate(e/120); c.fillStyle = '#fff'; c.shadowColor = '#fff'; c.shadowBlur = 30;
        c.beginPath(); for(let i=0;i<10;i++){ const rr = i%2 ? u*.025 : u*.06, a = -Math.PI/2 + i*Math.PI/5; c.lineTo(Math.cos(a)*rr, Math.sin(a)*rr); } c.closePath(); c.fill(); c.restore();
      }
      // おじいちゃんが飛び込む
      const oe = e - 550;
      if(oe > 0 && OJII.complete && OJII.naturalWidth){
        const p = Math.min(1, oe/450), ih = u*.6*(.3 + .7*easeBack(p)), iw = ih * OJII.naturalWidth / OJII.naturalHeight;
        const hop = Math.abs(Math.sin(oe/170))*u*.02;
        c.save(); c.translate(w/2, h*.62 - hop); c.rotate(Math.sin(oe/300)*.05);
        c.shadowColor = 'rgba(255,240,180,.95)'; c.shadowBlur = 36;
        c.drawImage(OJII, -iw/2, -ih/2, iw, ih); c.restore();
      }
      // （文字は表示しない：画像と光だけ）
      // 最初の白フラッシュ
      if(e < 160){ c.globalAlpha = 1 - e/160; c.fillStyle = '#fff'; c.fillRect(0,0,w,h); }
      c.globalAlpha = 1;
      return e < dur;
    }
    // タップしてもスキップしない（見逃さないように最後まで見せる）
    return {start, get active(){ return active; }};
  })();

  // ================================================================
  // 8-4. ボーナスステージ突入演出（全画面）
  //      幕が開く → 光の中からボーナスキャラが飛び出す → 「BONUS STAGE」
  // ================================================================
  const bonusIn = (() => {
    const cv = $('bonusIn'), c = cv.getContext('2d');
    let active = false, t0 = 0, dur = 3600, dpr = 1, info = null, onEnd = null, conf = [], useVideo = false;
    const easeBack = x => 1 + 2.7*Math.pow(x-1,3) + 1.7*Math.pow(x-1,2);
    const easeOut = x => 1 - Math.pow(1 - x, 3);
    function start(opt, cb){
      if(active){ cb && cb(); return; }
      info = opt; onEnd = cb; dpr = Math.min(2, window.devicePixelRatio || 1);
      dur = reduceMotion ? 1800 : 3600;
      useVideo = bvReady() || BV.readyState >= 1;
      if(useVideo){
        try { BV.currentTime = 0; } catch(e){}
        BV.play().catch(() => { useVideo = false; });
        dur = Math.round((BV.duration || 8) * 1000) + 200;
        sfx.stopBuf('bigwin'); sfx.playBuf('bonusin', 1);   // 動画の音声
      }
      conf = Array.from({length:90}, () => ({x:Math.random(), y:-Math.random()*.6, v:.12 + Math.random()*.18, r:Math.random()*6, vr:(Math.random()-.5)*.3,
        c:['#FF4F8B','#FFE14D','#4FF3FF','#9B5CFF','#5DFFB0','#fff'][Math.floor(Math.random()*6)], s:4 + Math.random()*5}));
      active = true; t0 = performance.now(); cv.hidden = false;
      if(!useVideo && performance.now() - (state.bigwinSndAt || -1e9) > 4800) sfx.bonusIn();
      requestAnimationFrame(loop);
    }
    function finish(){ if(!active) return; active = false; cv.hidden = true; try { BV.pause(); } catch(e){} const f = onEnd; onEnd = null; f && f(); }
    function loop(t){
      try { if(step(t)) requestAnimationFrame(loop); else finish(); }
      catch(err){ console.error(err); finish(); }
    }
    // 動画版：縦長の動画を画面いっぱいに（はみ出す分は切り落とす）。最後の約2秒で虹色の「BONUS STAGE」
    function stepVideo(t, w, h, u){
      const e = t - t0;
      c.fillStyle = '#000'; c.fillRect(0,0,w,h);
      if(bvReady()){
        const sc = Math.max(w / BV.videoWidth, h / BV.videoHeight), vw = BV.videoWidth*sc, vh = BV.videoHeight*sc;
        c.drawImage(BV, (w - vw)/2, (h - vh)/2, vw, vh);
      }
      const te = e - (dur - 2300);
      if(te > 0){
        const p = Math.min(1, te/300), sc2 = p < 1 ? 2.2 - 1.2*easeOut(p) : 1 + .03*Math.sin(te/90);
        let fs = Math.min(w*.17, 104); c.font = `900 ${fs}px "Titan One","M PLUS 1p",Impact,sans-serif`;
        const tw = c.measureText('BONUS STAGE').width; if(tw > w*.94) fs *= w*.94/tw;
        c.save(); c.globalAlpha = Math.min(1, te/200) * (e > dur - 250 ? Math.max(0, (dur - e)/250) : 1);
        c.translate(w/2, h*.085); c.scale(sc2, sc2); c.transform(1, 0, -.15, 1, 0, 0);   // 画面の上のほう（キャラの顔にかからない位置）
        c.font = `900 ${fs}px "Titan One","M PLUS 1p",Impact,sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
        c.lineWidth = fs*.22; c.strokeStyle = '#2a0010'; c.strokeText('BONUS STAGE', 0, 0);
        c.lineWidth = fs*.1; c.strokeStyle = '#fff'; c.strokeText('BONUS STAGE', 0, 0);
        const gr = c.createLinearGradient(-w*.45, 0, w*.45, 0), o = (e/4) % 360;
        for(let i=0;i<=6;i++) gr.addColorStop(i/6, `hsl(${(o + i*55) % 360},100%,60%)`);
        c.shadowColor = '#FFD23A'; c.shadowBlur = 24; c.fillStyle = gr; c.fillText('BONUS STAGE', 0, 0);
        c.restore();
        if(te < 220){ c.fillStyle = `rgba(255,255,255,${.6*(1 - te/220)})`; c.fillRect(0,0,w,h); }
      }
      return e < dur;
    }
    function step(t){
      const r = cv.getBoundingClientRect(), w = r.width || innerWidth, h = r.height || innerHeight, u = Math.min(w, h);
      if(cv.width !== Math.round(w*dpr) || cv.height !== Math.round(h*dpr)){ cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr); }
      if(useVideo){ c.setTransform(dpr,0,0,dpr,0,0); return stepVideo(t, w, h, u); }
      const e = t - t0, k = dur === 3600 ? 1 : .5;
      c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,w,h);
      const fadeOut = e > dur - 350 ? Math.max(0, (dur - e)/350) : 1;
      c.globalAlpha = fadeOut;
      // 背景：金と虹の光
      const univ = info.type === 'S7' && UNIV_BG.complete && UNIV_BG.naturalWidth;
      if(univ){
        // 777ボーナス：Machida Universe の会場（画面を覆うように拡大）
        const sc = Math.max(w / UNIV_BG.naturalWidth, h / UNIV_BG.naturalHeight) * (1.05 + e/40000);
        const iw = UNIV_BG.naturalWidth*sc, ih = UNIV_BG.naturalHeight*sc;
        c.drawImage(UNIV_BG, (w - iw)/2, (h - ih)/2, iw, ih);
        c.fillStyle = 'rgba(20,0,60,.25)'; c.fillRect(0,0,w,h);
      } else {
        const bg = c.createRadialGradient(w/2, h*.5, 0, w/2, h*.5, Math.max(w,h)*.8);
        bg.addColorStop(0, '#FFF6C8'); bg.addColorStop(.3, '#FFB43A'); bg.addColorStop(.65, '#E0185A'); bg.addColorStop(1, '#3A0A5A');
        c.fillStyle = bg; c.fillRect(0,0,w,h);
      }
      c.save(); c.translate(w/2, h*.5); c.rotate(e/1800);
      for(let i=0;i<24;i++){ c.rotate(Math.PI/12); c.fillStyle = `hsla(${(i*30 + e/6) % 360},100%,70%,.22)`;
        c.beginPath(); c.moveTo(0,0); c.lineTo(Math.max(w,h), -u*.09); c.lineTo(Math.max(w,h), u*.09); c.fill(); }
      c.restore();
      // ボーナスキャラが下から飛び出す
      const ce = Math.max(0, e - 700*k);
      const S7 = info.type === 'S7' && MACHIDA.complete && MACHIDA.naturalWidth;
      if(ce > 0 && (S7 || (HEROINE.complete && HEROINE.naturalWidth))){
        const p = Math.min(1, ce/550), ih = u*.62*(.4 + .6*easeBack(p));
        const y = h*.62 + (1 - easeOut(p))*h*.5 - Math.abs(Math.sin(ce/220))*u*.015;
        c.save(); c.translate(w/2, y); c.rotate(Math.sin(ce/400)*.04);
        c.shadowColor = S7 ? 'rgba(255,150,40,.95)' : 'rgba(255,240,200,.95)'; c.shadowBlur = 40;
        if(S7){ const cell = MACHIDA.naturalWidth / 5; c.drawImage(MACHIDA, 2*cell, 2*cell, cell, cell, -ih*.55, -ih*.55, ih*1.1, ih*1.1); }   // 炎をまとって飛び込むポーズ
        else { const iw = ih * HEROINE.naturalWidth / HEROINE.naturalHeight; c.drawImage(HEROINE, -iw/2, -ih/2, iw, ih); }
        c.restore();
      }
      // 紙吹雪
      if(e > 600*k) for(const p of conf){ p.y += p.v*.016; p.r += p.vr;
        c.save(); c.translate(p.x*w, p.y*h); c.rotate(p.r); c.fillStyle = p.c; c.fillRect(-p.s/2, -p.s/4, p.s, p.s/2); c.restore(); }
      // 文字：BONUS STAGE と目標枚数
      const te = e - 1000*k;
      if(te > 0){
        const p = Math.min(1, te/260), sc = p < 1 ? 2.2 - 1.2*easeOut(p) : 1 + .03*Math.sin(te/90);
        let fs = Math.min(w*.16, 96); c.font = `900 ${fs}px "M PLUS 1p", sans-serif`;
        const tw = c.measureText('BONUS STAGE').width; if(tw > w*.92) fs *= w*.92/tw;
        c.save(); c.translate(w/2, h*.17); c.scale(sc, sc); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
        c.font = `900 ${fs}px "M PLUS 1p", sans-serif`;
        const gr = c.createLinearGradient(0, -fs/2, 0, fs/2);
        gr.addColorStop(0, '#FFFBE6'); gr.addColorStop(.45, '#FFD23A'); gr.addColorStop(.55, '#E08A00'); gr.addColorStop(1, '#FFE9A0');
        c.lineWidth = fs*.2; c.strokeStyle = '#4a0030'; c.strokeText('BONUS STAGE', 0, 0);
        c.lineWidth = fs*.09; c.strokeStyle = '#FF2D78'; c.strokeText('BONUS STAGE', 0, 0);
        c.shadowColor = '#FFD23A'; c.shadowBlur = 24; c.fillStyle = gr; c.fillText('BONUS STAGE', 0, 0);
        c.restore();
        // サブタイトルと目標枚数
        const se = te - 350;
        if(se > 0){
          const sa = Math.min(1, se/250), sfs = Math.min(w*.065, 34);
          c.save(); c.globalAlpha *= sa; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
          c.font = `900 ${sfs}px "M PLUS 1p", sans-serif`;
          c.lineWidth = sfs*.25; c.strokeStyle = '#3a0030'; c.strokeText('イベント配信スタート！', w/2, h*.27);
          c.fillStyle = '#fff'; c.fillText('イベント配信スタート！', w/2, h*.27);
          // 目標枚数のバッジ
          const bw = Math.min(w*.88, 400), bh = sfs*1.7, by = h*.88;
          c.fillStyle = info.type === 'S7' ? '#D8192F' : '#161616'; c.strokeStyle = '#F2C14E'; c.lineWidth = 4;
          c.beginPath(); c.roundRect ? c.roundRect(w/2 - bw/2, by - bh/2, bw, bh, bh/2) : c.rect(w/2 - bw/2, by - bh/2, bw, bh); c.fill(); c.stroke();
          c.fillStyle = '#FFF3B0'; c.font = `900 ${sfs*.95}px "M PLUS 1p", sans-serif`;
          c.fillText(`${info.type === 'S7' ? '777 BONUS' : 'BAR AT'} ／ ${info.goal}枚まで`, w/2, by + 1);
          c.restore();
        }
      }
      // 幕（最初は閉じていて、左右に開く）
      const op = easeOut(Math.min(1, Math.max(0, (e - 150*k)/(650*k))));
      if(op < 1){
        const cw = w/2 * (1 - op);
        [[0, 1], [w, -1]].forEach(([x0, dir]) => {
          c.save(); c.translate(x0, 0); c.scale(dir, 1);
          const cg = c.createLinearGradient(0,0,cw,0); cg.addColorStop(0, '#5a0010'); cg.addColorStop(1, '#c0102a');
          c.fillStyle = cg; c.fillRect(0, 0, cw + 2, h);
          c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 6;
          for(let x = 18; x < cw; x += 26){ c.beginPath(); c.moveTo(x, 0); c.lineTo(x + Math.sin(e/200 + x)*4, h); c.stroke(); }
          c.fillStyle = '#F2C14E'; c.fillRect(cw - 4, 0, 6, h);
          c.restore();
        });
      }
      // 開く瞬間の白フラッシュ
      const fl = e - 650*k;
      if(fl > 0 && fl < 260){ c.globalAlpha = (1 - fl/260) * fadeOut; c.fillStyle = '#fff'; c.fillRect(0,0,w,h); }
      c.globalAlpha = 1;
      return e < dur;
    }
    // タップしてもスキップしない（見逃さないように最後まで見せる）
    return {start, get active(){ return active; }};
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
    try { fxStep(); } catch(err){ console.error(err); parts = []; fxRunning = false; }
  }
  function fxStep(){
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

  // 大当たり確定の告知：看板の流れ星が虹色に点灯し、液晶の視聴者数が「7777」（虹色）に固定される
  function setPeka(on){
    state.peka = on;
    const st = $('shooting');
    st.classList.toggle('lit', on);
    st.setAttribute('aria-label', on ? '流れ星 点灯（大当たり確定）' : '流れ星 消灯');
    screen.setLucky(on);
  }
  function pekaOn(type){
    state.pekaType = type;
    setPeka(true); sfx.gako(); screen.react();
    const key = state.dupBig || (BIG.includes(state.flag) ? state.flag : state.carry) || 'S7';
    setMsg('ボーナス！ボーナス！');
    // 回転中（先ペカ）は、演出が終わるまでSTOPを受け付けない
    if(state.phase === 'spinning') state.lockUntil = Math.max(state.lockUntil || 0, performance.now() + 60000);
    updateUI();
    // ほかの演出（カットイン・擬似連・激アツ・テンパイ煽りなど）が終わってから全画面演出へ。
    // 後ペカ（3つ目のSTOPで点灯）は、リールが止まって結果が出てから
    waitEffects(type === '後ペカ', () => kakutei.start(key, () => {
      if(state.peka){ screen.setAim(key); setMsg(`${key === 'S7' ? '777' : 'BAR・BAR・BAR'}を狙え！！`); }
      if(state.phase === 'spinning') state.lockUntil = performance.now() + 150;
      setTimeout(updateUI, 200);
    }));
  }
  function waitEffects(needIdle, cb){
    const busy = geki.active || bonusIn.active || performance.now() < (state.fxBusyUntil || 0)
      || (needIdle && state.phase === 'spinning') || state.tenpai;
    if(busy) setTimeout(() => waitEffects(needIdle, cb), 100); else cb();
  }

  // 7の停止音（ボーナス中は鳴らさない）
  //   第1停止：止めたリールの窓に7があれば鳴らす
  //   第2停止：2つのリールの7が同じライン上に並んだ（リーチ）ときだけ鳴らす
  //   第3停止：鳴らさない（揃ったときは専用の揃い音）
  function sevenStopSound(i){
    if(state.at) return;
    const stopped = reels.map((x, k) => x.spinning ? -1 : k).filter(k => k >= 0);
    if(stopped.length === 1){
      if([0,1,2].some(row => symAt(i, reels[i].stopPos, row) === 'S7')) sfx.playBuf('sevenStop', 1);
    } else if(stopped.length === 2){
      if(LINES.some(line => stopped.every(k => symAt(k, reels[k].stopPos, line[k]) === 'S7'))) sfx.playBuf('sevenStop', 1);
    }
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
    if(typeof checkMilestones === 'function') checkMilestones();
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
    { const be = battleExpect();
      $('dBattle').textContent = `${state.battle ? `${BATTLES[state.battle.type].name} R${state.battle.game}（${state.battle.win ? '勝ち' : '負け'}・星${state.battle.stars || '-'}）` : 'なし'}／期待度 全体${(be.all*100).toFixed(0)}%　`
        + Object.keys(BATTLES).map(k => `${BATTLES[k].name}${(be[k]*100).toFixed(0)}%`).join('・'); }
    $('dCut').textContent = ['green','red','rainbow'].map(c => `${{green:'緑',red:'赤',rainbow:'虹'}[c]} ${(expectOf(f => cutRow(f)[c] || 0)*100).toFixed(0)}%`).join(' / ');
    $('dGisi').textContent = `今回 ${state.gisi ? state.gisi + '段' : 'なし'}（③以上の期待度 ${(expectOf(f => gisiRow(f).slice(3).reduce((a,b)=>a+b,0))*100).toFixed(0)}%）`;
    $('setting').disabled = busy;
    // ステージ切り替えは通常ステージ（チャンス・ボーナス・大当たり確定中以外）で、回転していないときだけ
    $('stageSw').disabled = busy || !!state.at || !!state.cz || state.peka;
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
    $('bwText').textContent = 'BIG WIN!!';
    $('bwAmount').textContent = `AT ${AT_GOAL[key]}枚`;
    // 7揃いは専用の揃い音（約1.4秒）を先に鳴らし、そのあとBIG WINの音（約5秒）へ
    let played;
    if(key === 'S7' && sfx.playBuf('sevenAlign', 1.1)){
      sfx.stopBuf('sevenStop');
      played = true;
      state.bigwinSndAt = performance.now() + 1300;   // 突入演出側の重なり判定用
      setTimeout(() => sfx.bigwinSound(), 1300);
    } else played = sfx.bigwinSound();
    if(!played) setTimeout(sfx.atStart, 1900);
    setTimeout(hideBigWin, 3200);
    $('bigwin').hidden = false;
    if(!reduceMotion){ $('cab').classList.remove('shake'); void $('cab').offsetWidth; $('cab').classList.add('shake'); }
    if(!played) sfx.jackpot();
    [0,500,1000,1600].forEach(t => setTimeout(() => { spawn(70,'confetti'); spawn(35,'coin'); }, t));
  }
  function hideBigWin(){ $('bigwin').hidden = true; }
  // BIG WIN!! の表示もタップでは閉じない（自動で次の演出へ進む）

  // SPINボタン連打：回転中なら次のリールを左から止める
  function stopNext(){
    if(performance.now() - state.startTs < 180) return; // 押した直後の誤連打を無視
    if(performance.now() < state.lockUntil) return;     // 擬似連中は止められない
    const order = state.navi || [0,1,2];
    const i = order.find(k => reels[k].spinning && !reels[k].stopping);
    if(i !== undefined) stopReel(i);
  }

  // ================================================================
  // 告知ルート：7・BARに当選しても、すぐには教えない
  //   即ペカ 12% ／ 前兆 → リーチ 75% ／ チャンスステージ経由 10% ／ フリーズ 3%
  //   前兆中は当たりを保留し、カットイン・擬似連・激アツなどで煽ってから、
  //   バトルか特殊リーチの決着でだけ答えを出す
  // ================================================================
  const ROUTE_W = {instant:.12, zencho:.75, cz:.10, freeze:.03};
  const ZEN_GASA = 1/90;      // ハズレ・小役から始まるガセ前兆（前兆のうち本物はおよそ3回に1回）
  const CEILING = 666;        // 天井：通常時にこのゲーム数ボーナスが無ければ、バトル（S6）で救済
  const pickRoute = () => { let r = Math.random(); for(const [k,w] of Object.entries(ROUTE_W)){ if(r < w) return k; r -= w; } return 'zencho'; };
  function newZencho(big, ceiling){
    const reach = ceiling ? 'battle' : big ? (Math.random() < .65 ? 'battle' : 'sr') : (Math.random() < .5 ? (Math.random() < .5 ? 'battle' : 'sr') : 'none');
    return {big: big || null, left: ceiling ? 1 : 2 + Math.floor(Math.random()*5), reach, first: true, ceiling: !!ceiling};
  }
  // 保留中に、さらに7・BARを引いたらストック（ボーナス終了後に放出）
  function stockPush(k){ if(!k) return; (state.stock ||= []).push(k); }

  // ================================================================
  // ボーナス中の上乗せ・特化ゾーン、終了後の引き戻し、設定示唆
  // ================================================================
  const UWA_RATE = .25, UWA_AMOUNTS = [10, 10, 20, 20, 30, 50];
  const ZONE_RATE = 1/150, ZONE_GAMES = 5, ZONE_AMOUNTS = [10, 15, 15, 20, 30];
  const HIKI_GAMES = 10, HIKI_MULT = 3;
  function hikiTable(){
    const S7 = TABLE.find(t => t[0] === 'S7')[1] * HIKI_MULT, BAR = TABLE.find(t => t[0] === 'BAR')[1] * HIKI_MULT;
    const tot = S7 + BAR, k = tot > 30000 ? 30000/tot : 1;
    return TABLE.map(([key,w]) => [key, key === 'S7' ? Math.round(S7*k) : key === 'BAR' ? Math.round(BAR*k) : w]);
  }
  const HINTS = [
    {t:'おつかれさまでした！',               w:[6,6,6,6,6,6]},
    {t:'奇数っぽい…？',                       w:[3,0,3,0,3,0]},
    {t:'偶数っぽい…？',                       w:[0,3,0,3,0,3]},
    {t:'今日はアツい日かも',                  w:[0,0,1,2,3,4]},
    {t:'設定2以上確定！',                     w:[0,1,1,1,1,1]},
    {t:'設定4以上確定！',                     w:[0,0,0,1,1,1]},
    {t:'アルマンド入荷しました（設定6確定）', w:[0,0,0,0,0,.6]}
  ];
  function settingHint(){ const n = state.setting - 1; return HINTS[pickIdx(HINTS.map(h => h.w[n]))].t; }

  // ================================================================
  // 特殊リーチ（6種類）：ゲームをまたいで進むリーチ。結果は開始時に決まっている
  //   成功したときの行き先：大当たり／バトル発展／チャンスステージ
  //   7・BAR当選のゲームで始まった場合、当たりは結果発表まで保留する（バトルと同じ）
  // ================================================================
  const SR_TYPES = {
    icon:       {name:'アイコン詐欺を見破れ！',     w:18},
    audition:   {name:'リスナーオーディション中',   w:16},
    carriage:   {name:'かぼちゃの馬車に乗り込め！', w:16},
    family:     {name:'ファミリーよ！集結しろ！',   w:16},
    house:      {name:'コウジ、家を買う。',         w:16},
    hashiguchi: {name:'誰かが配信に遊びに来た！',   w:18}
  };
  const SR_RATE = {BIG:0, CHEM:.08, WML:.04, BEL:.04, CHE:.015, other:.003};   // 7・BAR当選時は告知ルート（前兆）から発生
  const srRate = f => isBig(f) ? SR_RATE.BIG : (SR_RATE[f] ?? SR_RATE.other);
  // ハズレ・小役で始まったときに成功する確率（7・BARのときは必ず成功）
  const SR_GASA_WIN = {icon:.25, audition:0, carriage:0, family:.25, house:.15, hashiguchi:.20};
  const AUDITION_NG = ['・・・', 'コインがありません！', '来月頑張らせてください！', 'なうならいけます！'];
  const FAMILY_LINES = ['なにがファミリーだよ💢', 'いいんだね？💢', '今日来ないやつはファミリーじゃない', '既読スルーは許さんぞ💢',
                        '推しは推せるときに推せって言ったよね？', '寝たやつ全員覚えとくからな', '枠閉じるぞ💢', 'ファミリー解散です'];
  const shuffle = a => { const b = a.slice(); for(let i=b.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  // オーディションの名前：いまプレイ中の人を優先し、足りなければリスナーから
  function pickNames(n){
    const online = shuffle(net.players().filter(x => x && x !== state.name));
    const rest = shuffle(LISTENERS.map(l => l.name).filter(x => !online.includes(x)));
    return online.concat(rest).slice(0, n);
  }
  function newSR(bigKey, type, force){
    const t = type || pickWeighted(SR_TYPES, 'w');
    const success = force ? force === 'win' : (!!bigKey || Math.random() < SR_GASA_WIN[t]);
    const sr = {type:t, big:bigKey || null, game:1, len:1, success, outcome:'none', d:{}};
    if(t === 'icon'){
      sr.d.icons = shuffle([0,1,2,3,4,5]).slice(0,3); sr.d.picked = -1;
      sr.outcome = success ? (bigKey || Math.random() < .5 ? 'battle' : 'cz') : 'none';
    }
    if(t === 'audition'){
      sr.d.names = pickNames(3);
      const failAt = success ? -1 : pickIdx([.3,.35,.35]);
      sr.d.replies = [0,1,2].map(i => failAt === -1 || i < failAt ? 'はい！いけます！' : i === failAt ? pick(AUDITION_NG) : null);
      sr.len = failAt === -1 ? 4 : failAt + 2;
      sr.outcome = success ? 'big' : 'none';
    }
    if(t === 'carriage'){
      sr.d.at = success ? 1 + pickIdx([.1,.15,.2,.25,.3]) : 0;   // 何ゲーム目で乗り込めるか（後ろほど多い）
      sr.len = sr.d.at || 5;
      sr.outcome = success ? 'big' : (Math.random() < .3 ? 'cz' : 'none');
    }
    if(t === 'family'){
      const r = (a, b) => a + Math.floor(Math.random()*(b - a + 1));
      sr.d.counts = success ? [r(5,8), r(11,15), 20] : [r(3,7), r(8,12), r(12,19)];
      sr.d.line = pick(FAMILY_LINES); sr.len = 3;
      sr.outcome = success ? 'battle' : 'none';
    }
    if(t === 'house'){
      sr.d.price = pick(['3,980万円', '5,800万円', '1億2,000万円']); sr.len = 3;
      sr.outcome = success ? (bigKey ? 'big' : 'cz') : 'none';
    }
    if(t === 'hashiguchi'){ sr.len = 3; sr.outcome = success ? 'battle' : 'none'; }
    if(sr.outcome === 'big' && !sr.big) sr.big = Math.random() < 1/3 ? 'S7' : 'BAR';   // デバッグで成功させたとき用
    return sr;
  }
  // アイコン詐欺：タップしたアイコンの正体を明かす
  function srIconPick(i){
    const sr = state.sr; if(!sr || sr.type !== 'icon' || sr.d.picked >= 0) return;
    sr.d.picked = i; screen.srPick(i, sr.success);
    (sr.success ? sfx.srReveal : sfx.battleLose)();
    state.lockUntil = performance.now() + 1600;
    setTimeout(updateUI, 1650);
  }
  // 結果の反映（最後のゲームが止まったあと）
  function srEnd(){
    const sr = state.sr; state.sr = null;
    screen.srResult(sr);
    const wait = 2200;
    setTimeout(() => {
      state.srPending = false; screen.srEnd();
      if(sr.outcome === 'big' || ((sr.outcome === 'none' || sr.outcome === 'cz') && sr.big)){
        state.carry = sr.big; pekaOn('リーチ成功');
      } else if(sr.outcome === 'battle'){
        state.srBattle = {type:null, win: !!sr.big, big: sr.big};
        setMsg('バトル発展!! SPINでバトル開始');
      } else if(sr.outcome === 'cz' || Math.random() < .15){
        enterCZ();   // 失敗しても15%でチャンスステージへ
      }
      save(); updateUI();
    }, wait);
  }

  // ================================================================
  // 次回予告（前兆）：ゲームの終わりに「次回配信のお知らせ」を出し、次のゲームの当たりを予告する
  //   ・予告を出すときは、次のゲームの抽選を先に済ませておき、その結果に合わせて中身を選ぶ
  //     （抽選の確率そのものは変わらないので、出玉率には影響しない）
  //   ・タイトル・サムネの色・出演者・配信日時・コメント数で期待度が変わる
  //   ・バリエーション：書き換え（昇格）、シルエット、バトル予告、放送事故（プレミア＝確定）
  // ================================================================
  const PV_TITLES = ['まったり雑談配信', 'ギフト企画やります！', 'コラボ配信するよ', '重大発表あり', 'アルマンド開けます'];
  const PV_DATES  = ['来週のどこか', '明日 20:00〜', '今夜 21:00〜', 'このあとすぐ！', '今すぐ！'];
  const PV_CAST   = ['コウジ', 'タキシード', 'おじいちゃん', '覚醒町田さん'];
  const PV_RATE = {BIG:.30, CHEM:.10, WML:.06, BEL:.06, CHE:.03, other:.012};
  const pvRate = f => isBig(f) ? PV_RATE.BIG : (PV_RATE[f] ?? PV_RATE.other);
  function pickIdx(w){ let r = Math.random()*w.reduce((a,b)=>a+b,0); for(let i=0;i<w.length;i++){ if(r < w[i]) return i; r -= w[i]; } return 0; }
  function buildPreview(hot, forcedKind){
    const big = isBig(hot), mid = ['CHEM','WML','BEL'].includes(hot);
    const tw = big ? [.04,.12,.28,.32,.24] : mid ? [.30,.35,.25,.10,0] : [.55,.30,.12,.03,0];
    const pv = {
      title: pickIdx(tw), color: pickIdx(tw), date: pickIdx(tw),
      cast: pickIdx(big ? [.2,.3,.3,.2] : mid ? [.45,.35,.2,0] : [.6,.3,.1,0]),
      comments: big ? 5 + Math.floor(Math.random()*4) : mid ? 3 + Math.floor(Math.random()*3) : 1 + Math.floor(Math.random()*3),
      kind: 'thumb', from: null, silhouette: false, battle: null
    };
    let kind = forcedKind;
    if(!kind){
      if(big && Math.random() < .08) kind = 'accident';
      else if(Math.random() < (big ? .25 : .12)) kind = 'battle';
      else if(Math.random() < .25) kind = 'rewrite';
      else if(Math.random() < .25) kind = 'silhouette';
      else kind = 'thumb';
    }
    pv.kind = kind;
    if(kind === 'rewrite'){ pv.title = Math.max(pv.title, 2); pv.from = Math.floor(Math.random()*pv.title); }
    if(kind === 'silhouette') pv.silhouette = true;
    if(kind === 'battle'){ const b = newBattle(big, false, null); pv.battle = {type:b.type, win:b.type === 's6' ? true : big}; }
    if(kind === 'accident'){ pv.title = 4; pv.color = 4; pv.date = 4; pv.cast = 3; pv.comments = 8; }
    return pv;
  }
  // ゲーム終了時に、次回予告を出すかどうか（出す場合は次のゲームの抽選をここで済ませる）
  function maybePreview(){
    if(state.at || state.cz || state.peka || state.carry || state.battle || state.battlePending || state.nextDraw || state.czPending || state.sr || state.srPending || state.srBattle || state.zencho || state.zSR) return;
    const dbg = debugSettings();
    let f = dbg.flag !== undefined ? dbg.flag : lottery(TABLE);
    if(dbg.preview === 'accident' && !BIG.includes(f)) f = 'S7';   // デバッグ：放送事故は確定なので7にする
    let dup = null;
    if(DUP[f] && (dbg.dup ? dbg.dup === 'on' : Math.random() < DUP[f])){ const st = SETTINGS[state.setting]; dup = Math.random() < st.S7/(st.S7 + st.BAR) ? 'S7' : 'BAR'; }
    const hot = dup || f;
    if(!(dbg.preview || Math.random() < pvRate(hot))) return;   // 出さないときは先取りした抽選を捨てる（偏りは出ない）
    const pv = buildPreview(hot, dbg.preview && dbg.preview !== 'on' ? dbg.preview : null);
    state.nextDraw = {flag:f, dup, pv};
    state.previewUntil = performance.now() + 600 + PV_DUR;
    setTimeout(() => { screen.preview(pv); sfx.preview(pv); }, 600);
  }
  const PV_DUR = 3400;

  // ================================================================
  // フリーズ（プレミア）：7・BAR当選の3%。レバーを押しても画面が暗転してリールが動かず、
  // ゆっくり逆回転してから「FREEZE」→ 大当たり確定。ボーナスが100枚上乗せされる
  // ================================================================
  // 流れ：リールがガタガタ → 暗転（効果音）→ 逆回転（約3秒）→ 暗転（約2秒）→ パトランプが降りてくる
  //       →「パトランプを押せ!!」→ 押すとキュイン！ → 大当たり確定の画面へ
  const FREEZE_RATE = .03;
  const FZ = {shake:800, black:600, reverse:3000, black2:2000};
  function startFreeze(){
    const t0 = performance.now(), fx = $('freezeFx'), win = document.querySelector('.window');
    state.freezeUntil = Infinity; state.freezePhase = 'shake'; state.freezeT0 = t0;
    state.lockUntil = Infinity;   // パトランプを押すまでSTOPは効かない
    state.freezeBonus = 100;
    fx.hidden = false; fx.className = 'freeze';
    // ① リールがガタガタ
    win.classList.add('rattle'); sfx.freezeRattle();
    // ② 暗転（効果音）
    setTimeout(() => { win.classList.remove('rattle'); state.freezePhase = 'black'; fx.className = 'freeze black'; sfx.freezeBlack(); }, FZ.shake);
    // ③ うっすら明るくなって、リールが逆回転（約3秒）
    setTimeout(() => { state.freezePhase = 'reverse'; state.freezeRevT = performance.now(); fx.className = 'freeze dim'; sfx.freezeRumble(); }, FZ.shake + FZ.black);
    // ④ ふたたび暗転（約2秒・無音）
    setTimeout(() => { state.freezePhase = 'black2'; fx.className = 'freeze black'; }, FZ.shake + FZ.black + FZ.reverse);
    // ⑤ パトランプが降りてくる
    setTimeout(() => {
      state.freezePhase = 'lamp'; fx.className = 'freeze black lamp';
      $('patlamp').hidden = false; $('plText').hidden = false; sfx.siren(true);
      if(autoOn) setTimeout(pressPatlamp, 3000);   // オートプレイ中は自動で押す
    }, FZ.shake + FZ.black + FZ.reverse + FZ.black2);
  }
  function pressPatlamp(){
    if(state.freezePhase !== 'lamp') return;
    state.freezePhase = 'done';
    sfx.siren(false); sfx.kyuinSynth();
    const fx = $('freezeFx');
    fx.className = 'freeze flash';
    $('patlamp').classList.add('pressed');
    setTimeout(() => {
      fx.hidden = true; fx.className = 'freeze'; $('patlamp').hidden = true; $('plText').hidden = true; $('patlamp').classList.remove('pressed');
      state.freezeUntil = performance.now();   // ここからリールが通常回転に戻る
      net.send('premier', 'フリーズ');
      pekaOn('フリーズ');
    }, 450);
  }
  $('patlamp').addEventListener('click', e => { e.stopPropagation(); audio.init(); pressPatlamp(); });


  // ================================================================
  // バトルリーチ（5ゲーム連続演出）
  //   ・7・BAR当選（重複含む）の40%でバトルに発展。当たりは5G目まで「保留」して、勝てば大当たり
  //   ・小役やハズレでも低確率で始まる（負けバトル）。途中で7・BARを引けば逆転勝利に変わる
  //   ・バトルは4種類。種類によって期待度が違う（S6ライバー全員を倒せ ＞ イベント出場 ＞ ラップ ＞ 通常）
  // ================================================================
  const BATTLES = {
    gun:   {name:'通常バトル',          foe:'夜の帝王・黒服', winW:25, loseW:50},
    rap:   {name:'ラップバトル',        foe:'MCギフト',      winW:30, loseW:30},
    event: {name:'イベント出場',        foe:'ライバル配信者', winW:25, loseW:15},
    s6:    {name:'S6ライバー全員を倒せ', foe:'S6ライバー',    winW:20, loseW:0}   // 出たら大当たり確定
  };
  const BATTLE_RATE = {BIG:.40, CHEM:.08, WML:.04, BEL:.04, CHE:.02, GRP:.004, RPL:.003, other:.002};
  const battleRate = f => isBig(f) ? BATTLE_RATE.BIG : (BATTLE_RATE[f] ?? BATTLE_RATE.other);
  function pickWeighted(obj, key){ const ks = Object.keys(obj); let r = Math.random()*ks.reduce((a,k)=>a+obj[k][key],0);
    for(const k of ks){ if(r < obj[k][key]) return k; r -= obj[k][key]; } return ks[0]; }
  // バトルのアツさ（星1〜5）。勝つバトルほど星が多い。S6ライバーは虹色の星5つ（確定）
  function pickStars(win){
    const w = win ? [0, 0, .15, .40, .45] : [.45, .35, .15, .05, 0];
    let r = Math.random(); for(let i=0;i<5;i++){ if(r < w[i]) return i + 1; r -= w[i]; } return win ? 4 : 1;
  }
  // 擬似連から発展するときの擬似連の段数（勝つバトルほど段数が多い）
  function pickPreGisi(win){
    const w = win ? [.12, .20, .26, .22, .20] : [.40, .30, .18, .09, .03];
    let r = Math.random(); for(let i=0;i<5;i++){ if(r < w[i]) return i + 1; r -= w[i]; } return 1;
  }
  // ハズレ・小役の擬似連がバトルに発展する確率（段数が多いほど発展しやすい）
  const GISI_DEV = [0, .08, .18, .35, .55, .75];
  function newBattle(win, comeback, type){
    let t = type || pickWeighted(BATTLES, win ? 'winW' : 'loseW');
    if(t === 's6' && !win) t = 'event';   // S6ライバーは勝ち確定なので、負けバトルにはしない
    // 1〜4G目の攻防（勝つバトルほどコウジ優勢の展開が多い）
    const turns = Array.from({length:4}, () => Math.random() < (win && !comeback ? .65 : .38) ? 'hero' : 'enemy');
    return {type:t, win, comeback: !!comeback, game:1, turns, hp:[100,100], rank:5, alive:6, big:null,
            stars: t === 's6' ? 5 : pickStars(win), rainbow: t === 's6'};
  }
  // バトルの種類ごとの7・BAR期待度（デバッグ表示用）
  function battleExpect(){
    let win = 0, lose = 0;
    effDist().forEach(([k,p]) => { const r = battleRate(k); if(isBig(k)) win += p*r; else lose += p*r; });
    const sw = Object.values(BATTLES).reduce((a,e)=>a+e.winW,0), sl = Object.values(BATTLES).reduce((a,e)=>a+e.loseW,0);
    const out = {}; for(const [k,e] of Object.entries(BATTLES)){ const w = win*e.winW/sw, l = lose*e.loseW/sl; out[k] = w/(w+l); }
    out.all = win/(win+lose); return out;
  }
  // 1ゲーム分の展開
  function battleTurn(i){
    const b = state.battle; if(!b) return;
    // 3ゲーム目：勝ちバトルは「乱入昇格」や「星昇格」が起きることがある
    if(i === 2 && b.win && !b.comeback){
      if((b.type === 'gun' || b.type === 'rap') && Math.random() < .15){
        b.type = 's6'; b.stars = 5; b.rainbow = true; b.alive = 6; screen.battleUpgrade(b, '乱入!? S6ライバー戦に昇格!!'); sfx.srReveal();
      } else if(b.stars < 5 && Math.random() < .4){ b.stars++; screen.battleUpgrade(b, '星昇格!!'); sfx.srReveal(); }
    }
    const who = b.turns[i] || 'hero';
    let dmg = 14 + Math.floor(Math.random()*11);
    if(b.type === 'event') b.rank = who === 'hero' ? Math.max(2, b.rank - 1) : Math.min(5, b.rank + 1);   // 優勝は最終ゲームで決まる
    else if(b.type === 's6'){ if(who === 'hero'){ dmg = Math.random() < .4 ? 2 : 1; b.alive = Math.max(1, b.alive - dmg); } }
    else { const target = who === 'hero' ? 1 : 0; b.hp[target] = Math.max(18, b.hp[target] - dmg); }   // 決着は5G目なので途中では倒れない
    screen.battleAct(who, dmg, {hp:b.hp.slice(), rank:b.rank, alive:b.alive});
    sfx.battleHit(who);
  }
  const BATTLE_MSG = {
    gun:   ['夜の帝王・黒服を撃破！', '黒服にやられてしまった…'],
    rap:   ['ラップバトル勝利！', 'MCギフトに言い負かされた…'],
    event: ['イベント優勝！！', '惜しくも2位…優勝ならず'],
    s6:    ['S6ライバー全員撃破！', 'S6ライバーに囲まれてしまった…']
  };
  // 5G目の結果
  function battleResult(){
    const b = state.battle; state.battle = null;
    state.battlePending = true;   // 決着の演出中は次のゲームを始めない
    if(b.win){
      screen.battleResult(true, b.comeback);
      (b.comeback ? sfx.battleComeback : sfx.battleWin)();
      setMsg(b.comeback ? `逆転!! ${BATTLE_MSG[b.type][0]}` : BATTLE_MSG[b.type][0]);
      net.send('btwin', BATTLES[b.type].name);
      if(b.comeback) net.send('premier', '逆転勝利');
      setTimeout(() => { state.carry = b.big || 'S7'; state.battlePending = false; pekaOn('バトル勝利'); save(); updateUI(); }, b.comeback ? 2600 : 1800);
    } else {
      screen.battleResult(false); sfx.battleLose();
      setMsg(BATTLE_MSG[b.type][1]);
      setTimeout(() => {
        state.battlePending = false; if(!state.battle) screen.battleEnd();
        if(Math.random() < .25 && !state.at && !state.cz){ setMsg('まだ終わらない！ チャンスステージへ'); enterCZ(); }   // 負けたあとの受け皿
      }, 2600);
    }
  }



  function pull(){
    if(!state.ready) return;
    if(state.phase === 'spinning'){ stopNext(); return; }
    if(state.battlePending) return;   // バトルの決着演出中
    if(performance.now() < (state.previewUntil || 0)) return;   // 次回予告の表示中
    if(state.srPending) return;                                  // 特殊リーチの結果発表中
    // スキップ予約が残っていたら、次のゲームを始めずにスキップする
    if(state.skipQueued && state.at){ skipAT(); return; }
    audio.init();
    if(audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
    finishCount(); hideBigWin();
    const cost = state.replay ? 0 : BET;
    if(state.credits < cost){
      setMsg('メダルが足りません。チャージしてください');
      showCharge(true);
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
    forceStage = false;
    try {

    // --- 内部抽選（デバッグで固定されていればそれを使う。AT中はAT用テーブル）---
    // 確定後（持ち越し中）のゲームは「狙うべきゲーム」としてミスを数える
    state.aimGame = !state.at && !!state.carry;
    const hikiNow = !state.at && !state.cz && !state.carry && (state.hiki || 0) > 0;   // ボーナス終了後の引き戻しゾーン
    const auto = state.at ? lottery(AT_TABLE) : (state.carry || lottery(state.cz ? czTable() : hikiNow ? hikiTable() : TABLE));
    if(!state.at){ state.sinceBig = (state.sinceBig || 0) + 1; if(hikiNow){ state.hiki--; screen.setHiki(state.hiki); } }
    state.czGame = !!state.cz && !state.at;  // このゲームがチャンスステージ中か
    state.flag = dbg.flag !== undefined ? dbg.flag : auto;
    // 小役の重複当選（7・BAR）。当たったら次ゲームに持ち越して揃える
    state.dupBig = null;
    if(!state.at && !state.carry && DUP[state.flag]){
      const on = dbg.dup ? dbg.dup === 'on' : Math.random() < DUP[state.flag];
      if(on){ const st = SETTINGS[state.setting]; state.dupBig = Math.random() < st.S7/(st.S7 + st.BAR) ? 'S7' : 'BAR'; }
    }
    // 次回予告で先に抽選しておいた結果があれば、それを使う
    { const nd = state.nextDraw; state.nextDraw = null; state.forceBattle = null;
      if(nd && !state.at && !state.cz && !state.peka && !state.carry && !state.battle){
        state.flag = nd.flag; state.dupBig = nd.dup;
        if(nd.pv.kind === 'battle') state.forceBattle = nd.pv.battle;
        if(nd.pv.kind === 'accident') state.pvAccident = true;   // 放送事故（プレミア）のあとは即ペカ
        if(nd.pv.silhouette) screen.reveal(nd.pv);
      } }
    state.freezeUntil = 0;
    if(!state.zencho) screen.setZen(null);
    let hot = state.dupBig || state.flag;   // 演出の抽選に使う「本当の当選状況」
    state.gisiSolo = null; state.preGisi = 0; state.introDelay = 0;
    // ---------- チャンスステージ経由のルート：ステージ中に「昇格」してバトルへ ----------
    if(state.cz && state.czStock && !state.at && (state.cz.played || 0) >= state.czStock.at){
      const k = state.czStock.big; state.czStock = null;
      state.cz = null; screen.setCZ(null); state.czGame = false;
      state.srBattle = {type:null, win:true, big:k, promo:true};
      setMsg('昇格!! バトル発展');
    }
    state.czHold = false;
    if(state.cz && !state.at && !state.peka && !state.carry && (BIG.includes(state.flag) || state.dupBig)){
      const k = state.dupBig || state.flag;
      if(state.czStock) stockPush(k); else state.czStock = {big:k, at:(state.cz.played || 0) + 1};   // 次のゲームで昇格
      if(BIG.includes(state.flag)) state.flag = null;
      state.dupBig = null; hot = 'BIG'; state.czHold = true;   // このゲームは煽り（カットイン・激アツ）だけ
    }
    // ---------- 告知ルート（当選してもすぐには教えない） ----------
    state.zGame = false; state.routeInstant = false; state.routeFreeze = false; state.routeCZ = false; state.ceilingHit = false;
    const routeOK = !state.at && !state.cz && !state.peka && !state.carry && !state.battle && !state.sr && !state.srBattle && !state.pvAccident && !state.forceBattle;
    if(routeOK && !state.zencho){
      const forced = dbg.battle || dbg.sr || dbg.freeze === 'on';
      if((state.sinceBig || 0) >= CEILING && !forced){   // 天井
        state.flag = Math.random() < 1/3 ? 'S7' : 'BAR'; state.dupBig = null; hot = state.flag; state.ceilingHit = true;
      }
      if(isBig(hot) && !forced){
        const key = state.dupBig || state.flag;
        const route = state.ceilingHit ? 'zencho' : hikiNow ? 'instant' : (dbg.route || pickRoute());
        if(route === 'instant'){ state.routeInstant = true; if(hikiNow) setTimeout(() => setMsg('引き戻し!!'), 200); }
        else if(route === 'freeze') state.routeFreeze = true;
        else {
          if(route === 'cz'){ state.czStock = {big:key, at: 2 + Math.floor(Math.random()*6)}; state.routeCZ = true; }
          else { state.zencho = newZencho(key, state.ceilingHit); if(state.ceilingHit) setMsg('天井到達!!'); }
          if(BIG.includes(state.flag)) state.flag = null;
          state.dupBig = null; hot = state.zencho ? 'BIG' : null;
        }
      } else if(!isBig(hot) && !forced && (dbg.route === 'gasa' || Math.random() < ZEN_GASA)){
        state.zencho = newZencho(null, false);
      }
    }
    // ---------- 前兆中のゲーム ----------
    if(state.zencho && !state.at && !state.cz && !state.peka && !state.carry && !state.battle && !state.sr){
      const z = state.zencho;
      if(BIG.includes(state.flag) || state.dupBig){   // 前兆中に7・BARを引いた
        const k = state.dupBig || state.flag;
        if(!z.big){ z.big = k; if(z.reach === 'none') z.reach = 'battle'; } else stockPush(k);
        if(BIG.includes(state.flag)) state.flag = null;
        state.dupBig = null;
      }
      if(z.left <= 0){
        // 前兆の終わり：リーチへ発展（ガセは何も起きない）
        state.zencho = null; screen.setZen(null);
        if(z.reach === 'battle') state.srBattle = {type: z.ceiling ? 's6' : null, win: !!z.big, big: z.big, pre: true};
        else if(z.reach === 'sr') state.zSR = {big: z.big};
        else if(Math.random() < .2){ state.routeCZ = true; }   // ガセ前兆の受け皿
        hot = null;
      } else {
        state.zGame = true; z.left--; screen.setZen(z);
        hot = z.big ? 'BIG' : pick(['CHEM', 'BEL', 'WML', 'CHE', null]);   // 予告（カットイン・擬似連・激アツ）の抽選用のアツさ
      }
    }
    // ---------- 特殊リーチ ----------
    state.srGame = false;
    if(!state.at && !state.cz && !state.peka && !state.carry && !state.battleGame && (!state.zGame || state.zSR)){
      if(!state.sr){
        const fsr = dbg.sr;
        if(state.zSR){
          const zs = state.zSR; state.zSR = null;
          state.sr = newSR(zs.big, null, zs.big ? 'win' : null);
          screen.srStart(state.sr); sfx.srStart();
        } else if(!state.zGame && !state.routeInstant && !state.routeFreeze && dbg.freeze !== 'on' && !state.pvAccident && (fsr || Math.random() < srRate(hot))){
          const bigKey = isBig(hot) ? (state.dupBig || state.flag) : null;
          state.sr = newSR(bigKey, fsr && fsr !== 'on' ? fsr : null, dbg.srWin);
          screen.srStart(state.sr); sfx.srStart();
        }
      } else screen.srStep(state.sr);
      if(state.sr){
        state.srGame = true;
        // 特殊リーチ中に引いた7・BARは保留して、結果発表のあとに必ずペカらせる
        if(BIG.includes(state.flag) || state.dupBig){
          if(state.sr.big) stockPush(state.dupBig || state.flag); else state.sr.big = state.dupBig || state.flag;
          if(BIG.includes(state.flag)) state.flag = null;
          state.dupBig = null;
        }
        hot = null;
      }
    }
    // デバッグ：フリーズ強制のときは7当選にして、バトルにはしない
    if(dbg.freeze === 'on' && !state.at && !state.cz && !state.peka && !state.carry && !state.battle && !isBig(hot)){ state.flag = 'S7'; hot = 'S7'; }
    // ---------- バトルリーチ ----------
    state.battleGame = false;
    if(!state.at && !state.cz && !state.peka && !state.carry && !state.srGame && !state.zGame){
      if(!state.battle){
        // バトル開始の抽選。擬似連は「そのまま大当たり」にはせず、バトルに発展させる
        //   7・BAR当選：40%でバトル（そのうち65%は擬似連を経由）。バトルにならないときは擬似連も出さない
        //   ハズレ・小役：擬似連が出たら段数に応じて負けバトルに発展。発展しなければ「発展ならず」
        const fb = state.forceBattle || state.srBattle;   // 次回予告の「バトル予告」・特殊リーチからの発展
        const fromSR = !!state.srBattle; state.srBattle = null;
        if(!state.pvAccident){
        const forced = dbg.battle || (fb ? (fb.win ? 'win' : 'lose') : null), fg = (dbg.gisi !== null && dbg.gisi !== undefined) ? dbg.gisi : null, big = isBig(hot);
        let start = false, win = false, pre = 0;
        if(forced){ start = true; win = forced !== 'lose'; pre = fb && !fb.pre ? 0 : (fg ?? (Math.random() < .6 ? pickPreGisi(win) : 0)); }
        else if(big){ /* 7・BAR当選は告知ルートで振り分け済み（即ペカ・フリーズ） */ }
        else {
          const g0 = fg ?? pickGisi(hot);
          state.gisiSolo = g0;
          if(g0 > 0){ if(Math.random() < GISI_DEV[g0]){ start = true; pre = g0; state.gisiSolo = 0; } }
          else if(Math.random() < battleRate(hot)) start = true;
        }
        if(start){
          // 勝ちバトルの2割は、一度やられてから逆転する
          state.battle = newBattle(win, forced === 'comeback' || (!!fb && win && Math.random() < .2), dbg.enemy || (fb && fb.type));   // dbg.enemy＝バトルの種類
          if(state.battle.type === 's6' || state.battle.win){ state.battle.win = true;
            state.battle.big = (fb && fb.big) || (big ? (state.dupBig || state.flag) : (Math.random() < 1/3 ? 'S7' : 'BAR')); }
          state.preGisi = pre;
          const intro = () => { if(state.battle && state.battle.game === 1){ screen.battleStart(state.battle, pre > 0 || fromSR); sfx.battleStart();
            setTimeout(() => { if(state.battle && state.battle.game === 1) battleTurn(0); }, 1900); } };
          if(pre > 0){
            // 擬似連を見せ終わってから「バトル発展!!」
            state.introDelay = GISI_START + (pre - 1)*GISI_GAP + (pre === 5 ? GISI5_HOLD : 1200);
            setTimeout(intro, state.introDelay);
          } else { state.introDelay = 0; intro(); }
        }
        }   // 放送事故（プレミア）のあとはバトルにせず、そのまま確定へ
      } else if(state.battle.game < 5){
        battleTurn(state.battle.game - 1);
      } else { screen.battleFinal(); sfx.battleFinal(); }
      if(state.battle){
        state.battleGame = true;
        // バトル中に引いた7・BARは揃えずに保留し、5G目に勝利として発表（途中で引けば逆転）
        if(BIG.includes(state.flag) || state.dupBig){
          if(!state.battle.win){ state.battle.win = true; state.battle.comeback = true; }
          if(state.battle.big && state.battle.win) stockPush(state.dupBig || state.flag); else state.battle.big = state.battle.big || state.dupBig || state.flag;
          if(BIG.includes(state.flag)) state.flag = null;
          state.dupBig = null;
        }
        hot = null;   // バトル中はほかの予告を出さない
      }
    }
    // ---------- フリーズ（プレミア） ----------
    state.freezeGame = false;
    if(!state.at && !state.cz && !state.peka && !state.carry && !state.battleGame && !state.srGame && !state.zGame){
      if(isBig(hot) && (dbg.freeze === 'on' || state.routeFreeze)) state.freezeGame = true;
    }
    // 予告（液晶演出・カットイン・激アツ・擬似連）の抽選に使うアツさ。
    // 即ペカ・放送事故のあとは予告なしでいきなり光らせる（予告 → 即ペカ、という流れは作らない）
    const effHot = state.routeInstant || state.pvAccident ? null : hot;
    // 通常ステージのステージチェンジ（アツいほど起きやすく、7・BAR当選時はステージ3に行きやすい）
    if(!state.at && !state.cz && !state.peka && !state.battleGame && !state.freezeGame && !state.srGame && !state.zGame && !state.zencho){
      state.stageCount = (state.stageCount || 0) + 1;
      if(!state.stageLimit) state.stageLimit = 30 + Math.floor(Math.random()*21);   // 30〜50Gのどこかで強制移行
      const rate = dbg.stage ? 1 : isBig(hot) ? .12 : ['WML','BEL','CHEM'].includes(hot) ? .06 : .03;
      if(state.stageCount >= state.stageLimit || Math.random() < rate){
        state.stageCount = 0; state.stageLimit = 30 + Math.floor(Math.random()*21);
        const next = isBig(hot) && Math.random() < .6 && state.stage !== 3 ? 3 : pick([1,2,3,4].filter(n => n !== state.stage));
        state.stage = next; screen.changeStage(next); sfx.stage();
      }
    }
    // チャンスステージの継続ジャッジ中は、ゲーム開始時に煽り
    if(state.cz && !state.at && state.cz.left <= 5 && state.cz.cont !== null){
      const strong = state.cz.cont ? Math.random() < .6 : Math.random() < .2;
      screen.czAori(strong ? 'strong' : 'weak'); (strong ? sfx.czStrong : sfx.czWeak)();
    }
    // 押し順ぶどうは、最初に押したリールが決まるまで制御上の役が未定
    state.navi = NAVI[state.flag] || null;
    state.ctrlFlag = state.navi ? undefined : state.flag;

    if(state.at){
      state.scene = null;
      screen.startAT(state.navi);
      if(state.navi) setTimeout(sfx.navi, 150);
    } else {
      // --- 液晶演出の抽選（ランプ点灯中は通常演出）---
      state.scene = state.battleGame || state.freezeGame || state.srGame ? 'walk' : dbg.scene || (state.peka ? 'walk' : pickScene(effHot));
      screen.start(state.scene);
    }
    // --- 激アツ演出の抽選（通常時のみ）---
    state.geki = !state.at && !state.peka && !state.battleGame && !state.freezeGame && !state.srGame && (dbg.geki ? dbg.geki === 'on' : Math.random() < gekiRate(effHot) * (state.zGame ? .35 : 1));   // 前兆中は出すぎないように
    // --- カットイン・擬似連の抽選（通常時のみ）---
    state.cutin = state.battleGame && state.battle && state.battle.game >= 5 && Math.random() < .5 ? pickCutin(state.battle.win ? 'BIG' : 'CHE')   // 最終決戦のカットイン
      : state.at || state.battleGame || state.freezeGame || state.srGame ? null : (dbg.cut ? (dbg.cut === 'none' ? null : dbg.cut) : pickCutin(effHot));
    {
      let gs = 0;
      if(!state.at && !state.peka){
        if(state.battle && state.battle.game === 1 && state.preGisi) gs = state.preGisi;            // バトルに発展する擬似連
        else if(state.zGame) gs = dbg.gisi !== null && dbg.gisi !== undefined ? dbg.gisi : (Math.random() < .4 ? pickGisi(hot) : 0);   // 前兆中の擬似連（煽り）
        else if(!state.battleGame && !state.freezeGame && !state.srGame && !isBig(hot))                              // 発展しない擬似連（ガセ）
          gs = state.gisiSolo ?? (dbg.gisi !== null && dbg.gisi !== undefined ? dbg.gisi : pickGisi(hot));
      }
      state.gisi = gs;
    }
    state.gisiDone = 0;
    if(state.gisi === 5) state.geki = false; // ⑤で全画面の激アツが出るので第2停止の激アツは出さない
    // カットインがあるときは、見終わってから擬似連を始める
    state.gisiDelay = state.cutin ? CUT_DUR : 0;
    if(state.cutin){ const type = state.cutin; setTimeout(() => { screen.cutin(type); sfx.cutin(type); }, 60); state.cutin = null; }
    state.lockUntil = state.gisi ? performance.now() + GISI_START + state.gisiDelay + (state.gisi - 1)*GISI_GAP + GISI_FREEZE + 250 : 0;
    // ⑤は液晶で2秒見せたあと全画面の激アツ。終わるまでSTOPを受け付けない
    if(state.gisi === 5) state.lockUntil += GISI5_HOLD;
    if(state.introDelay) state.lockUntil = Math.max(state.lockUntil, performance.now() + state.introDelay + 300);
    if(state.srGame && state.sr.type === 'icon' && state.sr.d.picked < 0){
      state.lockUntil = Infinity;
      setTimeout(() => { if(state.sr && state.sr.type === 'icon' && state.sr.d.picked < 0) srIconPick(Math.floor(Math.random()*3)); }, autoOn ? 2000 : 9000);
    }
    else if(state.gisi && !state.battle && !state.zGame){
      // 発展しなかった擬似連：最後の段のあとに「発展ならず…」
      const endAt = GISI_START + state.gisiDelay + (state.gisi - 1)*GISI_GAP + (state.gisi === 5 ? GISI5_HOLD : 1150);
      setTimeout(() => screen.gisiFail(), endAt);
    }
    if(state.gisi) setTimeout(updateUI, state.lockUntil - performance.now() + 20);
    // このゲームの演出（カットイン・擬似連）が終わる時刻。大当たり確定の全画面演出はこれを待ってから出す
    { const now = performance.now(); let busy = state.gisiDelay ? now + CUT_DUR : 0;
      if(state.gisi) busy = now + GISI_START + state.gisiDelay + (state.gisi - 1)*GISI_GAP + (state.gisi === 5 ? GISI5_HOLD : 1150);
      state.fxBusyUntil = busy; }

    // --- ランプ（先ペカ／後ペカ）の抽選 ---
    state.postPeka = false;
    if(isBig(hot) && !state.peka && !state.at && !state.battleGame && !state.freezeGame && !state.srGame && !state.zGame && !state.czHold){
      const pre = state.pvAccident || (dbg.peka ? dbg.peka === 'pre' : Math.random() < PRE_PEKA);
      state.pvAccident = false;
      if(pre){ state.aimGame = true; setTimeout(() => pekaOn('先ペカ'), 120); }
      else state.postPeka = true;
    }

    clearWins();
    reels.forEach(r => { r.spinning = true; r.stopping = false; r.stopPos = null; r.slide = null; });
    } catch(err){
      // 想定外のエラーでも、ゲーム数だけ増えてリールが回らない状態にはしない（通常のゲームとして続行）
      console.error('pull', err);
      state.flag = state.flag ?? null; state.ctrlFlag = state.flag; state.navi = null;
      state.scene = 'walk'; state.geki = false; state.cutin = null; state.gisi = 0; state.gisiDelay = 0;
      state.lockUntil = 0; state.postPeka = false; state.freezeGame = false; state.freezeUntil = 0;
      try { screen.start('walk', null); } catch(e){}
    }
    state.phase = 'spinning';
    updateMap();
    applyReelSpeed();
    state.startTs = state.lastTs = performance.now();
    setMsg(state.at ? ''
      : state.peka ? `${(BIG.includes(state.flag) ? state.flag : state.carry) === 'S7' ? '777' : 'BAR・BAR・BAR'}を狙え！！`
      : state.battleGame ? (state.battle.game >= 5 ? '最終決戦！ 3つ目のSTOPで決着' : `バトル中 ROUND ${state.battle.game}/5`)
      : state.srGame ? (state.sr.type === 'icon' ? 'アイコンをタップして選んで！' : SR_TYPES[state.sr.type].name)
      : state.cz ? `チャンスステージ 残り${state.cz.left}G` : 'STOPで止めよう');
    if(!wasReplay && !state.freezeGame) sfx.coin();
    if(state.freezeGame){ setMsg('……'); startFreeze(); } else sfx.lever();   // フリーズ中は音が消える
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
    const aim = state.assist ? 'flag' : debugSettings().aim;
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
    if(pressed === 2 && state.geki){ state.geki = false; if(!state.peka) geki.start(); }
    // 3つ目のSTOPを押した瞬間に後ペカ
    const last = reels.every(x => x.stopping || !x.spinning);
    // バトル最終ゲーム：第3停止で激突
    if(last && state.battleGame && state.battle && state.battle.game >= 5){ screen.battleClash(); sfx.battleClash(); }
    // 第3停止：カットイン
    if(last && state.postPeka){ state.postPeka = false; pekaOn('後ペカ'); }
    updateUI();
  }

  function loop(ts){
    const dt = Math.min(ts - state.lastTs, 50);
    state.lastTs = ts;
    let v = SPEED * Math.min(1, (ts - state.startTs) / 250);
    if(state.freezeUntil){
      if(ts < state.freezeUntil){
        // 逆回転のときだけ動く（ゆっくり始まって、終わりぎわに減速）
        if(state.freezePhase === 'reverse'){ const re = ts - state.freezeRevT; v = -SPEED*.22*Math.min(1, re/500)*Math.min(1, Math.max(0, (FZ.reverse - re)/500)); }
        else v = 0;
      } else v = SPEED * Math.min(1, (ts - state.freezeUntil) / 400);
    }
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
          if(k === 5) setTimeout(() => { if(!state.peka && !state.battle) geki.start({title:'追いメガポコナイト〜🔥'}); }, GISI5_HOLD);
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
        r.p = r.stopPos; r.spinning = false; sfx.stop(i);
        sevenStopSound(i);
        if(!state.at && !state.battleGame && !state.srGame) checkTenpai();
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

    // 持ち越し：7・BARのゲームだけで更新する（小役のゲームで持ち越しが消えてしまう不具合の対策）
    if(!state.at && CARRY_OVER.includes(flag)) state.carry = hit ? null : flag;
    const dupHit = !state.at && !!state.dupBig;
    // バトルを1ゲーム進める（5G目なら決着）
    const wasBattle = state.battleGame || state.srGame;
    if(state.srGame && state.sr){
      if(state.sr.game >= state.sr.len){ state.srPending = true; setTimeout(srEnd, 500); }
      else state.sr.game++;
    }
    if(wasBattle && state.battle){
      if(state.battle.game >= 5){ state.battlePending = true; setTimeout(battleResult, 1300); }   // 一瞬の暗転の溜めをはさんで決着
      else state.battle.game++;
    }
    if(dupHit) state.carry = state.dupBig;   // 重複当選：次ゲームで7・BARを狙う
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
      state.missCount = 0; state.assist = false; showStaff(false); screen.setStaff(false);
      if(state.at){ state.at.goal += AT_GOAL[flag]; }
      else state.at = {type:flag, goal:AT_GOAL[flag], paid:0};
      // データ：履歴と天井カウンタ
      (state.hist ||= []).unshift({type:flag, g:state.sinceBig || 0}); state.hist = state.hist.slice(0, 10);
      state.bigs = (state.bigs || 0) + 1; state.sinceBig = 0; state.hiki = 0; screen.setHiki(0);
      if(state.freezeBonus){ state.at.goal += state.freezeBonus; state.freezeBonus = 0; setTimeout(() => setMsg(`フリーズ特典！ ボーナス+100枚（${state.at ? state.at.goal : ''}枚まで）`), 3400); }
      screen.setAT(state.at);
      screen.big(flag);
      showBigWin(flag);
      // お祝い（約3秒）が終わったら、そのままボーナスステージ（AT画面）へ
      // お祝いのあと、全画面の突入演出をはさんでボーナスステージ（AT画面）へ
      setTimeout(() => {
        if(!(state.at && state.phase !== 'spinning' && screen.mode === 'big')) return;
        hideBigWin();
        bonusIn.start({type:state.at.type, goal:state.at.goal}, () => {
          if(state.at && state.phase !== 'spinning'){ screen.startAT(null); screen.resultAT(0); setMsg(`ボーナスステージ！ ${state.at.goal}枚まで`); }
        });
      }, 3000);
      setMsg(`${SYM[flag].name}揃い！ AT突入（${AT_GOAL[flag]}枚まで）`);
      net.send('big', flag);
      $('topper').classList.add('party');
    } else if(state.at){
      // --- AT中 ---
      state.at.paid += total;
      screen.resultAT(total);
      // 上乗せ：AT中のチェリーで抽選／特化ゾーン「ギター覚醒タイム」中は毎ゲーム
      let add = 0;
      if(state.at.zone > 0){ add += pick(ZONE_AMOUNTS); state.at.zone--; }
      if(flag === 'CHE' && Math.random() < UWA_RATE) add += pick(UWA_AMOUNTS);
      if(add){ state.at.goal += add; screen.atAdd(add, state.at.zone); sfx.uwanose(); }
      if(!state.at.zone && Math.random() < ZONE_RATE){ state.at.zone = ZONE_GAMES; screen.atZone(); sfx.zoneIn(); setTimeout(() => setMsg('特化ゾーン「ギター覚醒タイム」突入！'), 300); }
      if(wins.length === 0) setMsg('はずれ');
      else if(state.replay){ setMsg('リプレイ'); sfx.replay(); }
      else { setMsg(`${SYM[wins[0].key].name}　${total}枚`); sfx.smallWin(); }
      if(total > 0) startCount(total, false);
      if(state.at.paid >= state.at.goal){ endAT(); state.skipQueued = false; $('skipBtn').classList.remove('queued'); $('skipBtn').textContent = 'SKIP ▶▶'; }

    } else {
      screen.resolve({flag, hit, big: dupHit || BIG.includes(flag), bigKey: dupHit ? state.dupBig : (BIG.includes(flag) ? flag : null)});
      if(wasTenpai){ sfx.tenpaiFail(); }
      if(wins.length === 0){
        if(state.peka && state.aimGame && BIG.includes(flag) && !hit){
          state.missCount++;
          const left = STAFF_MISS - state.missCount;
          setMsg(`${state.carry === 'S7' ? '777' : 'BAR・BAR・BAR'}を狙え！！` + (left > 0 ? `（ミス${state.missCount}回）` : '　店員アシストが使えます'));
          if(state.assist){ state.assist = false; screen.setStaff(false); }
          if(left <= 0) showStaff(true);
        } else setMsg(state.peka ? `${state.carry === 'S7' ? '777' : 'BAR・BAR・BAR'}を狙え！！` : 'はずれ。SPINでもう一回');
      } else if(state.replay){
        setMsg('リプレイ！次ゲームはベット不要'); sfx.replay();
      } else if(flag === 'WML'){
        setMsg(`スイカ！ ${total}枚獲得`);
        sfx.midWin(); party(1500);
        spawn(30, 'coin', windowCenter());
      } else {
        setMsg(`${SYM[wins[0].key].name}　${total}枚獲得`);
        sfx.smallWin();
        if(flag === 'CHE' || flag === 'CHEM') spawn(8, 'coin', windowCenter());
      }
      if(total > 0) startCount(total, false);
      // --- チャンスステージの消化と突入 ---
      if(state.czGame && state.cz){
        if(BIG.includes(flag) || dupHit) endCZ(true);       // 7・BAR当選でチャンスステージ終了（ボーナスへ）
        else czStep();
      } else if(!state.cz && !state.peka && !BIG.includes(flag) && !dupHit && !wasBattle && !state.battle && !state.sr && !state.srPending && !state.zencho && !state.srBattle && CZIN[flag]){
        // 小役で7・BARの抽選に外れたとき、チャンスステージへの移行を抽選
        if(debugSettings().czIn === 'on' || Math.random() < CZIN[flag]){ state.czPending = true; setTimeout(enterCZ, 700); }
      }
    }
    if(bigHit && state.cz) endCZ(true);
    state.dupBig = null;
    save(); updateUI();
    if(state.routeCZ && !state.at){ state.routeCZ = false; state.czPending = true; setTimeout(enterCZ, 700); }
    // 前兆の始まり：次回予告で合図（予告だけ見せる）
    if(state.zencho && state.zencho.first && !state.at){ state.zencho.first = false;
      if(Math.random() < .5){ const pv = buildPreview(state.zencho.big ? 'S7' : 'CHE'); if(pv.kind === 'battle' || pv.kind === 'accident') pv.kind = 'thumb';
        state.previewUntil = performance.now() + 600 + PV_DUR; setTimeout(() => { screen.preview(pv); sfx.preview(pv); }, 600); } }
    if(!state.at) maybePreview();
    recordData();
    // スキップ予約があれば、このゲームが止まった直後にその場で実行（以前は0.5秒後だったため、
    // その間に次のゲームが始まると予約が流れてしまうことがあった）
    if(state.skipQueued && state.at) skipAT();
    // メダルが尽きたら、払い出しのカウントが終わったころにチャージの案内
    setTimeout(() => { if(needCharge() && !countTimer) showCharge(true); }, 1500);
  }

  // チャンスステージ
  function enterCZ(){
    state.czPending = false;
    if(state.at || state.cz || state.phase === 'spinning') return;
    state.cz = {left:CZ_GAMES, played:0, set:1, cont:null};
    net.send('czin');
    screen.setCZ(state.cz); screen.czStart(); sfx.czIn();
    setMsg(`チャンスステージ突入！ ${CZ_GAMES}ゲーム`);
    save(); updateUI();
  }
  function endCZ(win, reason = ''){
    if(state.czStock){
      // 昇格前にチャンスステージが終わったら、次のゲームで昇格バトルへ（大当たりで終わったときはストック）
      if(win) stockPush(state.czStock.big); else state.srBattle = {type:null, win:true, big:state.czStock.big, promo:true};
      state.czStock = null;
    }
    const played = state.cz ? state.cz.played || 0 : 0;
    state.cz = null; screen.setCZ(null);
    if(!win) net.send('czend', played);   // 大当たりで終わったときは「大当たり」のお知らせだけ
    if(!win){ screen.czEnd(); sfx.czEnd(); setTimeout(() => { if(!state.at && state.phase !== 'spinning') setMsg(`チャンスステージ終了${reason}`); }, 300); }
  }
  // チャンスステージを1ゲーム進める。残り5Gで継続を抽選し、最終ゲームで結果を出す
  function czStep(){
    const cz = state.cz;
    cz.left--; cz.played = (cz.played || 0) + 1;
    if(cz.cont === undefined) cz.cont = null;
    if(cz.left === 5 && cz.cont === null){
      const forced = debugSettings().czCont;
      cz.cont = cz.played + 5 < CZ_MAX && (forced ? forced === 'on' : Math.random() < CZ_CONT);
      screen.setCZ(cz); sfx.czJudge();
    }
    if(cz.left <= 0){
      if(cz.cont){
        cz.left = CZ_GAMES; cz.cont = null; cz.set = (cz.set || 1) + 1;
        screen.setCZ(cz); screen.czResult(true); sfx.czCont();
        net.send('czcont', cz.set);
        setMsg(`チャンスステージ継続！ +${CZ_GAMES}G（${cz.set}セット目）`);
      } else {
        endCZ(false, cz.played >= CZ_MAX ? `（${CZ_MAX}G到達）` : '');
      }
    } else screen.setCZ(cz);
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
  const wakeAudio = () => { audio.init(); if(audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {}); };
  document.addEventListener('pointerdown', wakeAudio);
  document.addEventListener('keydown', wakeAudio);
  document.addEventListener('visibilitychange', () => { if(!document.hidden && audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {}); });
  $('autoBtn').addEventListener('click', () => { audio.init(); setAuto(!autoOn); if(autoOn) setMsg('オートプレイ中'); });
  setInterval(() => {
    if(!autoOn || !state.ready || geki.active || bonusIn.active || kakutei.active || !$('bigwin').hidden) return;
    const now = performance.now();
    if(state.peka && !state.at){ setAuto(false); setMsg('ランプ点灯！ オートを止めました。液晶の図柄を狙おう'); return; }
    if(state.phase === 'idle'){
      if(now - lastFinish < (countTimer ? 1200 : 700)) return;
      if(state.credits < BET && !state.replay){ setAuto(false); setMsg('メダルがなくなったのでオートを止めました'); showCharge(true); return; }
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
      if(state.at.zone > 0){ state.at.goal += pick(ZONE_AMOUNTS); state.at.zone--; }
      if(f === 'CHE' && Math.random() < UWA_RATE) state.at.goal += pick(UWA_AMOUNTS);
      if(!state.at.zone && Math.random() < ZONE_RATE) state.at.zone = ZONE_GAMES;
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

  // ================================================================
  // 同時プレイ人数＆みんなへのお知らせ：Firebase Realtime Database を使う
  //   ・presence/<匿名ID> … 今開いている人。閉じる・切断すると自動で消える → 液晶左上に人数表示
  //   ・events/<自動ID>   … 大当たりなどの出来事。他の人の液晶にメッセージが流れる
  //   ・FIREBASE_CONFIG が空のあいだは何もしない（今までどおり架空の視聴者数）
  // ================================================================
  // Firebaseの設定値（公開前提の値。読み書きできる範囲はデータベースのルールで制限している）
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyCJTBJQFfo-ORWfANsBQevro75ekl3R36Q',
    authDomain: 'machidaciaga.firebaseapp.com',
    databaseURL: 'https://machidaciaga-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'machidaciaga',
    appId: '1:114237876382:web:447c3e7476a8958755338f'
  };
  // お知らせの種類と文面
  const EVENT_TEXT = {
    big:     (n, d) => `🎉 ${n}さんが${d === 'S7' ? '777' : 'BAR'}で大当たり！`,
    broke:   (n)    => `💸 ${n}さんのメダルがなくなりました…`,
    k1000:   (n)    => `🪙 ${n}さんのメダルが1000枚を突破！`,
    premier: (n, d) => `🌈 ${n}さんがプレミア演出${d ? `「${d}」` : ''}を引いた！`,
    czin:    (n)    => `✨ ${n}さんがチャンスステージに突入！`,
    btwin:   (n, d) => `⚔ ${n}さんが${d || 'バトル'}で勝利！`,
    czcont:  (n, d) => `🔥 ${n}さんのチャンスステージが継続！${d ? `（${d}セット目）` : ''}`,
    czend:   (n, d) => `🌙 ${n}さんのチャンスステージが終了…${d ? `（${d}G）` : ''}`
  };
  const net = (() => {
    let db = null, uid = null, fb = null, joinedAt = Date.now(), lastSend = {}, players = [];
    async function init(){
      if(!FIREBASE_CONFIG.apiKey || !FIREBASE_CONFIG.databaseURL) return;
      try {
        const base = 'https://www.gstatic.com/firebasejs/10.12.2';
        const app_ = await import(`${base}/firebase-app.js`);
        const auth_ = await import(`${base}/firebase-auth.js`);
        fb = await import(`${base}/firebase-database.js`);
        const app = app_.initializeApp(FIREBASE_CONFIG);
        const {user} = await auth_.signInAnonymously(auth_.getAuth(app));   // 匿名ログイン（個人情報なし）
        uid = user.uid; db = fb.getDatabase(app);
        const me = fb.ref(db, `presence/${uid}`);
        fb.onValue(fb.ref(db, '.info/connected'), snap => {
          if(snap.val() !== true) return;
          fb.onDisconnect(me).remove().then(() => fb.set(me, {t: fb.serverTimestamp(), name: state.name || ''}));
        });
        fb.onValue(fb.ref(db, 'presence'), snap => {
          screen.setPlayers(Math.max(1, snap.size));
          players = []; snap.forEach(c => { const v = c.val(); if(c.key !== uid && v && v.name) players.push(cleanName(v.name)); });
        });
        // 開いた後に起きた、他の人の出来事だけを受け取る
        const q = fb.query(fb.ref(db, 'events'), fb.orderByChild('t'), fb.startAt(joinedAt - 5000));
        fb.onChildAdded(q, snap => {
          const e = snap.val();
          if(!e || e.uid === uid || !EVENT_TEXT[e.type]) return;
          receive(e);
        });
      } catch(err){ console.warn('オンライン機能を開始できませんでした', err); db = null; }
    }
    function receive(e){ screen.broadcast(EVENT_TEXT[e.type](cleanName(e.name), e.detail)); sfx.notify(); }
    // 出来事を送る（同じ種類は30秒に1回まで）
    function send(type, detail = ''){
      if(!state.name) return;
      const now = Date.now();
      if(lastSend[type] && now - lastSend[type] < 30000) return;
      lastSend[type] = now;
      if(!db) return;
      fb.push(fb.ref(db, 'events'), {uid, name: state.name, type, detail: String(detail).slice(0, 30), t: fb.serverTimestamp()}).catch(() => {});
    }
    function rename(){ if(db && uid) fb.update(fb.ref(db, `presence/${uid}`), {name: state.name}).catch(() => {}); }
    return {init, send, rename, players: () => players.slice(), test: (type = 'big') => receive({name:'テスト', type, detail: type === 'big' ? 'S7' : type === 'czcont' ? '2' : type === 'czend' ? '40' : ''})};
  })();
  // 名前に使えない文字を取り除いて、長さを制限する
  function cleanName(v){ return String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || '名無し'; }

  // ================================================================
  // リスナー名の登録（初回だけ表示。あとから「名前」ボタンで変更可）
  // ================================================================
  function openName(){
    $('nameInput').value = state.name || '';
    $('nameModal').hidden = false;
    setTimeout(() => $('nameInput').focus(), 50);
  }
  function saveName(){
    const v = cleanName($('nameInput').value);
    if(!$('nameInput').value.trim()){ $('nameErr').textContent = '名前を入力してください'; return; }
    state.name = v; store.set('slot.name', v);
    $('nameModal').hidden = true; $('nameErr').textContent = '';
    $('nameBtn').textContent = `👤 ${v}`;
    setMsg(`ようこそ、${v}さん！`);
    net.rename();
  }
  $('nameSave').addEventListener('click', saveName);
  $('nameInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); saveName(); } });
  $('nameBtn').addEventListener('click', openName);
  if(state.name) $('nameBtn').textContent = `👤 ${state.name}`;
  else setTimeout(openName, 1200);
  net.init();
  state.netReady = true;

  // メダル1000枚突破（一度超えたら、900枚を下回るまで再送しない）
  function checkMilestones(){
    if(!state.netReady) return;   // お知らせの準備ができてから判定
    if(state.credits >= 1000 && !state.over1000){ state.over1000 = true; store.set('slot.over1000', true); net.send('k1000'); }
    else if(state.credits < 900 && state.over1000){ state.over1000 = false; store.set('slot.over1000', false); }
  }

  // ================================================================
  // アップデート検知：公開中のバージョン（version.json）を定期的に確認し、
  // 今開いているものより新しければリロードボタンを出す
  // ================================================================
  const APP_VER = '202610040157';   // 書き出し時に日時（例：202610030253）へ置き換わる
  (function watchUpdate(){
    if(!/^\d+$/.test(APP_VER) || location.protocol === 'file:') return;   // プレビュー・ローカルでは確認しない
    let latest = null, dismissed = null;
    const check = () => fetch(`version.json?t=${Date.now()}`, {cache:'no-store'})
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if(!j || !j.ver || j.ver === APP_VER || j.ver === dismissed) return;
        latest = j.ver; $('updateBar').hidden = false;
      }).catch(() => {});
    setTimeout(check, 5000);
    setInterval(check, 60 * 1000);                                   // 1分ごと
    document.addEventListener('visibilitychange', () => { if(!document.hidden) check(); });   // アプリに戻ったときも
    $('updateBtn').addEventListener('click', () => {
      if(state.phase === 'spinning'){ setMsg('リールが止まってからリロードしてください'); return; }
      save();
      // HTML自体がキャッシュされていても新しい版を読むよう、URLにバージョンを付けて開き直す
      const q = new URLSearchParams(location.search); q.set('v', latest || Date.now());
      location.replace(`${location.pathname}?${q}${location.hash}`);
    });
    $('updateClose').addEventListener('click', () => { dismissed = latest; $('updateBar').hidden = true; });
  })();

  // アイコン詐欺リーチ：液晶のアイコンをタップして選ぶ
  $('screen').addEventListener('click', e => {
    const sr = state.sr; if(!sr || sr.type !== 'icon' || sr.d.picked >= 0) return;
    const r = $('screen').getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 320;
    srIconPick(x < 115 ? 0 : x < 205 ? 1 : 2);
  });

  // 動画の画質の切り替え（高画質は公開版のみ。通信量が多いので標準が初期値）
  $('videoQ').value = videoQ();
  if(!ATV_HD){ const o = $('videoQ').querySelector('option[value="hd"]'); o.disabled = true; o.textContent = '高画質（公開版のみ）'; }
  $('videoQ').addEventListener('change', e => {
    try { localStorage.setItem('slot.vq', JSON.stringify(e.target.value)); } catch(err){}
    applyVideoQuality();
    setMsg(e.target.value === 'hd' ? '動画：高画質（通信量が増えます）' : '動画：標準画質');
  });

  // リール速度の切り替え（回転中は次のゲームから反映）
  const applyReelSpeed = () => { SPEED = (REEL_SPEEDS[state.reelSpeed] || REEL_SPEEDS.normal).v; };
  $('reelSpeed').value = REEL_SPEEDS[state.reelSpeed] ? state.reelSpeed : 'normal';
  applyReelSpeed();
  $('reelSpeed').addEventListener('change', e => {
    state.reelSpeed = e.target.value; store.set('slot.reelSpeed', state.reelSpeed);
    if(state.phase !== 'spinning') applyReelSpeed();
    setMsg(`リールの速さ：${REEL_SPEEDS[state.reelSpeed].name}`);
  });

  // ================================================================
  // メダルのチャージ：足りなくなったら案内を出し、ボタンで100枚追加
  // （ゲーム数や出玉率などの記録はそのまま）
  // ================================================================
  const CHARGE = 100;
  function needCharge(){ return state.credits < BET && !state.replay && state.phase !== 'spinning'; }
  function showCharge(on){
    $('chargeBar').hidden = !on;
    if(on){ sfx.miss(); if(!state.brokeSent){ state.brokeSent = true; net.send('broke'); } }
  }
  $('chargeBtn').addEventListener('click', () => {
    audio.init();
    state.credits += CHARGE; state.charged = (state.charged || 0) + CHARGE; state.brokeSent = false;
    showCharge(false); sfx.coin();
    setMsg(`メダルを${CHARGE}枚チャージしました`);
    save(); updateUI();
  });
  $('chargeClose').addEventListener('click', () => showCharge(false));

  // ================================================================
  // データ：総ゲーム数・ボーナス回数・合成確率・天井まで・差枚グラフ・履歴
  // ================================================================
  function recordData(){
    (state.diffLog ||= []).push(state.coinOut - state.coinIn);
    if(state.diffLog.length > 600) state.diffLog = state.diffLog.filter((_, i) => i % 2 === 0);   // 長くなったら間引く
  }
  function renderData(){
    if(!$('dataBox').open) return;
    $('dGames').textContent = state.games;
    $('dBigs').textContent = state.bigs || 0;
    $('dRate').textContent = state.bigs ? `1/${(state.games / state.bigs).toFixed(1)}` : '-';
    $('dCeil').textContent = `${Math.max(0, CEILING - (state.sinceBig || 0))}G`;
    const diff = state.coinOut - state.coinIn; $('dDiff').textContent = (diff >= 0 ? '+' : '') + diff;
    $('dStock').textContent = (state.stock || []).length;
    $('dHist').innerHTML = (state.hist || []).map((h, i) => `<li>${h.type === 'S7' ? '7揃い' : 'BAR揃い'}（${h.g}G）</li>`).join('') || '<li>まだありません</li>';
    const cv = $('dGraph'), c = cv.getContext('2d'), d = state.diffLog || [];
    c.clearRect(0,0,cv.width,cv.height);
    if(d.length > 1){
      const max = Math.max(50, ...d.map(Math.abs)), mid = cv.height/2;
      c.strokeStyle = '#4A2A1A'; c.beginPath(); c.moveTo(0, mid); c.lineTo(cv.width, mid); c.stroke();
      c.strokeStyle = '#FFD23A'; c.lineWidth = 3; c.beginPath();
      d.forEach((v, i) => { const x = i/(d.length - 1)*cv.width, y = mid - v/max*(mid - 8); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
    }
  }
  $('dataBox').addEventListener('toggle', renderData);
  setInterval(renderData, 1000);

  // ステージ切り替えボタン：押すたびに 1→2→3→4→1 と切り替え（強制移行までのゲーム数も数え直す）
  const STAGE_NAMES = {1:'配信部屋', 2:'ゲーム部屋', 3:'バーラウンジ', 4:'実家'};
  $('stageSw').addEventListener('click', () => {
    if(state.phase === 'spinning' || state.at || state.cz || state.peka) return;
    audio.init();
    state.stage = state.stage % 4 + 1;
    state.stageCount = 0; state.stageLimit = 30 + Math.floor(Math.random()*21);
    screen.changeStage(state.stage); sfx.stage();
    setMsg(`STAGE CHANGE：${STAGE_NAMES[state.stage]}`);
    save(); updateUI();
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
  let videoWanted = false;
  setInterval(() => {
    const normal = state.sound && state.bgm && audio.ctx && !state.at && !state.battle && !state.tenpai && !geki.active
      && $('bigwin').hidden && !['big','atEnd'].includes(screen.mode);
    if(normal) bgm.start(); else bgm.stop();
    // ボーナスゲーム中（突入演出のあと、AT画面になってから終了まで）は専用BGM
    const bonus = state.sound && state.bgm && audio.ctx && state.at && !bonusIn.active && screen.mode !== 'big';
    if(bonus) bonusBgm.start(); else bonusBgm.stop();
    const wantVideo = !!(state.at && state.at.type === 'S7' && !bonusIn.active && screen.mode !== 'big');
    // ボーナスが始まるたびに最初から再生（前回の再生位置を持ち越さない）
    if(wantVideo && !videoWanted){ try { ATV.currentTime = 0; } catch(e){} }
    if(wantVideo && ATV.paused) ATV.play().catch(() => {});
    else if(!wantVideo && !ATV.paused) ATV.pause();
    if(!wantVideo && videoWanted){ try { ATV.currentTime = 0; } catch(e){} }   // 終わったら頭出ししておく
    videoWanted = wantVideo;
    $('skipBtn').hidden = !state.at;
  }, 200);

  // ================================================================
  // 店員アシスト：確定後に5回揃えられなかったらボタンを表示。
  // 押すと店員さんが代わりに目押しして、1ゲームで揃えてくれる
  // ================================================================
  const STAFF_MISS = 5;
  function showStaff(on){ $('staffBtn').hidden = !on; }
  $('staffBtn').addEventListener('click', () => {
    if(state.phase === 'spinning' || !state.peka || state.assist) return;
    audio.init();
    finishCount();
    state.assist = true; showStaff(false); setAuto(false);
    screen.setStaff(true); sfx.staff();
    setMsg('店員さんが目押しします！');
    // 店員さんの操作：レバー → 左・中・右の順に止める
    setTimeout(() => {
      pull();
      [1100, 1700, 2300].forEach(d => setTimeout(() => { if(state.assist) stopNext(); }, d));
    }, 900);
  });

  function endAT(){
    const info = {type:state.at.type, paid:state.at.paid};
    state.at = null;
    screen.atEnd(info);
    $('topper').classList.remove('party');
    setTimeout(() => { sfx.atEnd(); setMsg(`AT終了！ 獲得 ${info.paid}枚`); }, 400);
    // 設定示唆：店長のひとこと
    setTimeout(() => screen.say(settingHint(), ['🏪', '店長']), 1300);
    if(state.stock && state.stock.length){
      // 保留していた当たり（ストック）を放出
      setTimeout(() => { if(state.at || state.peka) return; state.carry = state.stock.shift(); setMsg('ストック放出!!'); pekaOn('ストック'); save(); updateUI(); }, 2400);
    } else {
      state.hiki = HIKI_GAMES; screen.setHiki(state.hiki);
      setTimeout(() => { if(!state.at) setMsg(`引き戻しチャンス！ ${HIKI_GAMES}ゲーム`); }, 2600);
    }
  }

  // デバッグ設定（パネルを開いている間だけ有効）
  const SCENE_KEYS = Object.keys(SCENES);
  $('fScene').insertAdjacentHTML('beforeend', SCENE_KEYS.map(k => `<option value="${k}">${SCENES[k]}</option>`).join(''));
  function debugSettings(){
    if($('debug').hidden) return {};
    const f = $('fFlag').value, s = $('fScene').value, p = $('fPeka').value, a = $('fAim').value, k = $('fGeki').value;
    const cu = $('fCut').value, gs = $('fGisi').value, du = $('fDup').value, cz = $('fCz').value;
    const bt = $('fBattle').value, en = $('fEnemy').value, pvw = $('fPreview').value, fz = $('fFreeze').value, srv = $('fSr').value, srw = $('fSrWin').value;
    const rt = $('fRoute').value;
    return {
      route: rt === 'auto' ? null : rt,
      sr: srv === 'auto' ? null : srv,
      srWin: srw === 'auto' ? null : srw,
      preview: pvw === 'auto' ? null : pvw,
      freeze: fz === 'auto' ? null : fz,
      battle: bt === 'auto' ? null : bt,
      enemy: en === 'auto' ? null : en,
      dup: du === 'auto' ? null : du,
      czIn: cz === 'on' ? 'on' : null,
      czCont: cz === 'auto' ? null : cz,
      stage: forceStage,
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
    if(state.cz) endCZ(true);
    state.at = {type, goal:AT_GOAL[type], paid:0};
    setPeka(false); state.carry = null; screen.setAim(null);
    state.missCount = 0; state.assist = false; showStaff(false); screen.setStaff(false);
    screen.setAT(state.at); screen.startAT(null); screen.resultAT(0);
    $('topper').classList.add('party');
    setMsg(`デバッグ：AT開始（${AT_GOAL[type]}枚まで）`); save(); updateUI();
  }
  $('atS7').addEventListener('click', () => debugAT('S7'));
  $('czBtn').addEventListener('click', () => { audio.init(); enterCZ(); });
  let forceStage = false;
  $('stageBtn').addEventListener('click', () => { forceStage = true; setMsg('次のゲームでステージが変わります'); });
  $('gekiPrev').addEventListener('click', () => { audio.init(); geki.start(); });
  $('netTest').addEventListener('click', () => { audio.init(); net.test(pick(Object.keys(EVENT_TEXT))); });
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
    if(state.cz){ state.cz = null; screen.setCZ(null); }
    state.nextDraw = null; state.pvAccident = false; state.previewUntil = 0;
    state.sr = null; state.srBattle = null; state.srPending = false; screen.srEnd();
    state.zencho = null; state.czStock = null; state.stock = []; state.hiki = 0; state.sinceBig = 0; state.bigs = 0; state.hist = []; state.diffLog = [];
    screen.setZen(null); screen.setHiki(0);
    if(state.battle){ state.battle = null; screen.battleEnd(); }
    state.missCount = 0; state.assist = false; showStaff(false); screen.setStaff(false);
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
  if(state.cz && !state.at){ state.cz = {left:state.cz.left, played:state.cz.played || 0, set:state.cz.set || 1, cont:state.cz.cont ?? null}; screen.setCZ(state.cz); }
  screen.setStage(state.stage);
  if(state.zencho) screen.setZen(state.zencho);
  if(state.hiki) screen.setHiki(state.hiki);
  // 特殊リーチの途中で閉じた場合：保留中の当たりがあれば、そのままペカらせる
  if(saved && saved.sr && saved.sr.big && !state.at && !state.carry){ state.carry = saved.sr.big; state.pekaType = '持ち越し'; setPeka(true); screen.setAim(state.carry); }
  if(state.battle && !state.at) screen.battleRestore(state.battle);
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
