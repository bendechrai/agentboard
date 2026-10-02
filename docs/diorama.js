/*
 * The agentboard diorama: a miniature board with six status lanes and a
 * small crew of agents that claim, work, hand off, block and merge tickets.
 *
 * Everything on screen is a pure function of the loop time t (0..LOOP), so
 * the same scene renders live in the page and frame by frame for captures
 * (window.agentboardDiorama.render(t)). The story is a script of actor
 * steps that compiles into motion segments, card events, speech bubbles and
 * the lines of the event tape.
 */
(function () {
  'use strict';

  var host = document.getElementById('diorama');
  var canvas = document.getElementById('diorama-canvas');
  var overlay = document.getElementById('diorama-overlay');
  var tapeEl = document.getElementById('tape-lines');
  if (!host || !canvas || !window.THREE) return;

  var THREE = window.THREE;
  var PI = Math.PI;
  var params = new URLSearchParams(location.search);
  var CAPTURE = params.has('render');
  var reduce = !CAPTURE && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var LOOP = 40;

  // ------------------------------------------------------------------ layout
  var LANES = [
    { id: 'todo', label: 'TODO', color: '#cfd5db' },
    { id: 'tests', label: 'TESTS', color: '#f1c977' },
    { id: 'implementing', label: 'IMPLEMENTING', color: '#86c9b9' },
    { id: 'review', label: 'REVIEW', color: '#bcaae6' },
    { id: 'blocked', label: 'BLOCKED', color: '#f09a86' },
    { id: 'merged', label: 'MERGED', color: '#a6d38f' }
  ];
  var LANE_W = 4.6, LANE_STEP = 5.05, LANE_Z0 = -4.7, LANE_Z1 = 1.7;
  var laneX = {};
  LANES.forEach(function (l, i) { laneX[l.id] = (i - 2.5) * LANE_STEP; });
  var PILE_Z = -2.35, SPOT_Z = -0.55, HOME_Z = 4.35;
  var MAT_Y = 0.06, CARD_H = 0.07, STACK = 0.085;

  // Each agent stands at its own spot in front of a pile (off, dz), so two
  // agents at the same lane never overlap.
  var AGENTS = [
    { id: 'orchestrator', color: '#e3b23c', home: -13.8, off: -1.2, dz: 0.3 },
    { id: 'test-author-1', color: '#ef7f3a', home: -9.6, off: 1.15, dz: 0 },
    { id: 'test-author-2', color: '#d6578a', home: -5.6, off: -1.15, dz: 0.1 },
    { id: 'impl-1', color: '#23a08a', home: -0.9, off: -0.2, dz: 1.3 },
    { id: 'impl-2', color: '#3a86d6', home: 5.2, off: 1.25, dz: 1.1 },
    { id: 'reviewer-1', color: '#8a62d4', home: 9.4, off: -1.2, dz: 0.9 }
  ];
  var agentById = {};
  AGENTS.forEach(function (a) { agentById[a.id] = a; });

  // ------------------------------------------------------------------ the script
  var SPEED = 3.1;
  var segs = {};      // agent id -> [{t0, t1, from:[x,z], to:[x,z], state, yaw}]
  var cardEv = [];    // {t, card, type: 'pick'|'drop'|'spawn'|'close', by?, pile?}
  var bubbles = [];   // {t0, t1, agent, text, kind}
  var tape = [];      // {t, kind, ticket, actor, note, bad}

  var HASHES = 'e3b0 9f3c 5d1a c08e 71b4 2a9f 8c6d f41e 0b7a 6e25 d93c 47f0 b215 3c8e a0d4 18e9 7f62 c5ab 2e07 94d1 6a3f e8b2 1d56 bc49 503e 8f1a';
  HASHES = HASHES.split(' ');
  var TICKETS = { A: '01M3XX798M', B: '01M3XX798B', C: '01M3XX797Y', D: '01M3XX798X', E: '01M3XX7996' };

  function spot(lane, agent) { var a = agentById[agent]; return [laneX[lane] + a.off, SPOT_Z + a.dz]; }
  function travel(from, to) { var dx = to[0] - from[0], dz = to[1] - from[1]; return Math.sqrt(dx * dx + dz * dz) / SPEED + 0.25; }
  function home(agent) { return [agentById[agent].home, HOME_Z]; }

  function Actor(id) {
    this.id = id; this.t = 0; this.p = home(id); this.face_ = 0; this.heading = 0; segs[id] = [];
  }
  // Every segment knows the heading it starts from and, when the agent is
  // standing, which way it faces: the lanes when it is at a pile, the viewer
  // when it is at home.
  Actor.prototype.push = function (state, dur, to, yaw) {
    var s = { t0: this.t, t1: this.t + dur, from: this.p, to: to || this.p, state: state, yaw: yaw === undefined ? this.face_ : yaw, start: this.heading };
    segs[this.id].push(s); this.t += dur; this.p = s.to; this.heading = s.yaw; return this;
  };
  Actor.prototype.until = function (t) { if (t > this.t) this.push('idle', t - this.t); return this; };
  Actor.prototype.walk = function (to) {
    var dx = to[0] - this.p[0], dz = to[1] - this.p[1], d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.01) return this;
    this.push('walk', d / SPEED + 0.25, to, Math.atan2(dx, dz));
    this.face_ = to[1] < 2 ? PI : 0;
    return this;
  };
  Actor.prototype.face = function (yaw) { this.face_ = yaw; return this; };
  Actor.prototype.pick = function (card) {
    this.face(PI); cardEv.push({ t: this.t + 0.22, card: card, type: 'pick', by: this.id });
    return this.push('reach', 0.45);
  };
  Actor.prototype.drop = function (card, pile) {
    this.face(PI); cardEv.push({ t: this.t + 0.22, card: card, type: 'drop', pile: pile, by: this.id });
    return this.push('reach', 0.45);
  };
  Actor.prototype.work = function (dur) { this.face(PI); return this.push('work', dur); };
  Actor.prototype.say = function (text, kind, dur) {
    bubbles.push({ t0: this.t, t1: this.t + (dur || 2.6), agent: this.id, text: text, kind: kind || '' }); return this;
  };
  Actor.prototype.log = function (kind, ticket, note, bad) {
    tape.push({ t: this.t, kind: kind, ticket: TICKETS[ticket], actor: this.id, note: note || '', bad: !!bad }); return this;
  };
  Actor.prototype.goHome = function () { return this.walk(home(this.id)).face(0); };
  // The time `card` lands on `pile` (its latest drop there scripted so far),
  // so an agent never picks a card up before it has arrived.
  function lands(card, pile) {
    var t = null;
    cardEv.forEach(function (e) { if (e.card === card && e.pile === pile && (e.type === 'drop' || e.type === 'spawn')) t = e.t; });
    if (t === null) throw new Error('diorama script: ' + card + ' never lands on ' + pile);
    return t + 0.35;
  }

  var orch = new Actor('orchestrator'), ta = new Actor('test-author-1'), ta2 = new Actor('test-author-2'),
    i1 = new Actor('impl-1'), i2 = new Actor('impl-2'), rv = new Actor('reviewer-1');
  var CREW = [orch, ta, ta2, i1, i2, rv];

  // A claim race: both test authors reach for the top card in the same
  // instant, neither seeing the other's claim. Both claim events are written;
  // the fold gives C to the earlier one and rejects the other, which takes
  // the next card instead.
  var raceAt = 0.4 + Math.max(travel(home('test-author-1'), spot('todo', 'test-author-1')), travel(home('test-author-2'), spot('todo', 'test-author-2')));
  ta.until(raceAt - travel(home('test-author-1'), spot('todo', 'test-author-1'))).walk(spot('todo', 'test-author-1'));
  ta2.until(raceAt - travel(home('test-author-2'), spot('todo', 'test-author-2'))).walk(spot('todo', 'test-author-2'));
  ta.until(raceAt).log('ticket.claim', 'C').pick('C').say('claimed', 'ok', 1.6);
  ta2.until(raceAt + 0.04).log('ticket.claim', 'C', 'rejected: already-assigned', true).push('reach', 0.45)
    .say('already-assigned', 'warn', 1.8).push('idle', 1.0).say('taking the next one', '', 1.6)
    .log('ticket.claim', 'B').pick('B');
  // test-author-1 writes the tests on C and hands it to impl-1.
  ta.walk(spot('tests', 'test-author-1')).log('ticket.move', 'C', 'tests').drop('C', 'tests').work(2.2)
    .say('red tests are in', 'ok', 2).pick('C').walk(spot('implementing', 'test-author-1'))
    .log('ticket.handoff', 'C', 'to impl-1 (implementing)').drop('C', 'implementing').say('handoff: impl-1', '', 1.8).goHome();
  // test-author-2 does the same with B.
  ta2.walk(spot('tests', 'test-author-2')).log('ticket.move', 'B', 'tests').drop('B', 'tests').work(3.0)
    .say('red tests are in', 'ok', 1.8).pick('B').walk(spot('implementing', 'test-author-2'))
    .log('ticket.handoff', 'B', 'to impl-1 (implementing)').drop('B', 'implementing').say('handoff: impl-1', '', 1.8).goHome();
  // impl-1 takes C, hits a wall, parks it on the blocked pile and leaves it.
  // Like every agent here, it only moves once the hand-off has happened.
  i1.until(lands('C', 'implementing') + 0.3).say('inbox: handoff from test-author-1', '', 1.7).push('idle', 0.8)
    .walk(spot('implementing', 'impl-1')).pick('C').work(2.6)
    .say('needs a schema change first', 'warn', 2.6).walk(spot('blocked', 'impl-1'))
    .log('ticket.move', 'C', 'blocked').drop('C', 'blocked')
    .log('ticket.comment', 'C', 'needs a schema change first').log('ticket.release', 'C').say('released', '', 1.4);
  // ...then goes back to implementing and picks up B as soon as it lands.
  i1.walk(spot('implementing', 'impl-1')).until(lands('B', 'implementing')).pick('B').work(3.2).say('green', 'ok', 1.8)
    .walk(spot('review', 'impl-1')).log('ticket.handoff', 'B', 'to reviewer-1 (review)').drop('B', 'review').goHome();
  // impl-2 rescues C from the blocked pile, takes it back to implementing and finishes it.
  // It only reacts once the card has landed there, the way `agentboard watch` would tell it.
  i2.until(lands('C', 'blocked') + 0.5).say('watch: 01M3XX797Y blocked', '', 1.6).push('idle', 0.9)
    .walk(spot('blocked', 'impl-2')).say("I've got it", '', 1.8).log('ticket.claim', 'C').pick('C')
    .walk(spot('implementing', 'impl-2')).log('ticket.move', 'C', 'implementing').drop('C', 'implementing').work(2.6)
    .say('green', 'ok', 1.8).pick('C').walk(spot('review', 'impl-2'))
    .log('ticket.handoff', 'C', 'to reviewer-1 (review)').drop('C', 'review').goHome();
  // reviewer-1 merges B, then records a decision on C and merges it.
  var reviewQueue = [];
  cardEv.forEach(function (e) { if (e.type === 'drop' && e.pile === 'review') reviewQueue.push(e); });
  reviewQueue.sort(function (a, b) { return a.t - b.t; });
  rv.until(reviewQueue[0].t + 0.6).say('inbox: handoff from ' + reviewQueue[0].by, '', 1.7).push('idle', 0.8)
    .walk(spot('review', 'reviewer-1')).pick(reviewQueue[0].card).work(1.8).say('LGTM', 'ok', 1.6)
    .walk(spot('merged', 'reviewer-1')).log('ticket.move', reviewQueue[0].card, 'merged').drop(reviewQueue[0].card, 'merged');
  cardEv.push({ t: rv.t + 0.5, card: reviewQueue[0].card, type: 'close' });
  rv.log('ticket.close', reviewQueue[0].card, 'merged');
  rv.walk(spot('review', 'reviewer-1')).until(reviewQueue[1].t + 0.3).pick(reviewQueue[1].card).work(1.6)
    .say('DECISION: rank by recency', 'decision', 2.8).log('ticket.comment', reviewQueue[1].card, 'DECISION: rank by recency')
    .work(1.0).walk(spot('merged', 'reviewer-1')).log('ticket.move', reviewQueue[1].card, 'merged').drop(reviewQueue[1].card, 'merged');
  cardEv.push({ t: rv.t + 0.5, card: reviewQueue[1].card, type: 'close' });
  rv.log('ticket.close', reviewQueue[1].card, 'decision: adr/0004-ranking.md').goHome();
  // The orchestrator imports the next change: two new tickets land on todo.
  var spawnAt = rv.t - 2.0;
  orch.until(spawnAt - 2.2).walk(spot('todo', 'orchestrator')).say('import-change add-search', '', 2.4);
  cardEv.push({ t: orch.t + 0.4, card: 'D', type: 'spawn', pile: 'todo' });
  cardEv.push({ t: orch.t + 1.0, card: 'E', type: 'spawn', pile: 'todo' });
  orch.log('ticket.create', 'D').push('work', 0.6).log('ticket.create', 'E').push('work', 0.8).goHome();

  var endT = 0;
  CREW.forEach(function (a) { endT = Math.max(endT, a.t); });
  if (endT > LOOP - 0.5) LOOP = Math.ceil(endT + 1);
  CREW.forEach(function (a) { a.until(LOOP + 1); });
  tape.sort(function (a, b) { return a.t - b.t; });
  tape.forEach(function (e, i) { e.hash = HASHES[i % HASHES.length]; });

  // Card timelines: replay the pile operations in time order to get stack heights.
  var CARDS = ['A', 'B', 'C', 'D', 'E'];
  var piles = {}; LANES.forEach(function (l) { piles[l.id] = []; });
  var cardTl = {};
  CARDS.forEach(function (c) { cardTl[c] = []; });
  function tl(c, entry) { entry._card = c; cardTl[c].push(entry); }
  ['A', 'B', 'C'].forEach(function (c, i) { piles.todo.push(c); tl(c, { t: -1, kind: 'pile', pile: 'todo', idx: i }); });
  ['D', 'E'].forEach(function (c) { tl(c, { t: -1, kind: 'hidden' }); });
  var pileSnaps = {};
  LANES.forEach(function (l) { pileSnaps[l.id] = [{ t: -1, cards: piles[l.id].slice() }]; });
  function snap(t) { LANES.forEach(function (l) { var list = pileSnaps[l.id], last = list[list.length - 1].cards; if (last.join() !== piles[l.id].join()) list.push({ t: t, cards: piles[l.id].slice() }); }); }
  var held = {};
  cardEv.sort(function (a, b) { return a.t - b.t; }).forEach(function (e) {
    if (e.type === 'pick' && held[e.card]) console.warn('diorama script: ' + e.card + ' picked at ' + e.t.toFixed(2) + ' while carried by ' + held[e.card]);
    if (e.type === 'drop' && !held[e.card]) console.warn('diorama script: ' + e.card + ' dropped at ' + e.t.toFixed(2) + ' without being carried');
    if (e.type === 'pick') held[e.card] = e.by; else if (e.type === 'drop') held[e.card] = null;
    var p;
    if (e.type === 'pick') {
      LANES.forEach(function (l) { var i = piles[l.id].indexOf(e.card); if (i >= 0) piles[l.id].splice(i, 1); });
      tl(e.card, { t: e.t, kind: 'carried', by: e.by });
    } else if (e.type === 'drop' || e.type === 'spawn') {
      p = piles[e.pile]; tl(e.card, { t: e.t, kind: e.type === 'spawn' ? 'spawn' : 'pile', pile: e.pile, idx: p.length }); p.push(e.card);
    } else if (e.type === 'close') {
      LANES.forEach(function (l) { var i = piles[l.id].indexOf(e.card); if (i >= 0) piles[l.id].splice(i, 1); });
      tl(e.card, { t: e.t, kind: 'gone' });
    }
    snap(e.t);
  });
  // A card's height on its pile at time t: its place in the pile as it stands then.
  function stackIndex(pile, card, t, fallback) {
    var list = pileSnaps[pile], cur = list[0];
    for (var i = 1; i < list.length && list[i].t <= t; i++) cur = list[i];
    var idx = cur.cards.indexOf(card);
    return idx < 0 ? fallback : idx;
  }

  // ------------------------------------------------------------------ scene
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: CAPTURE });
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  var scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9dccb');

  function C(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }
  function std(hex, o) { var p = { color: C(hex), roughness: 0.86, metalness: 0 }; if (o) for (var k in o) p[k] = o[k]; return new THREE.MeshStandardMaterial(p); }
  function box(w, h, d, mat) { var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.castShadow = true; m.receiveShadow = true; return m; }

  var MONO = '"Martian Mono", ui-monospace, Menlo, monospace';
  function textTexture(w, h, draw) {
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var g = cv.getContext('2d'); draw(g, w, h);
    var tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 8; return tex;
  }

  var world = new THREE.Group(); scene.add(world);

  // The ground the board stands on, and the board itself.
  var ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), std('#e4d4bf', { roughness: 1 }));
  ground.rotation.x = -PI / 2; ground.position.y = -1.2; ground.receiveShadow = true; world.add(ground);
  var plinth = box(33.6, 1.1, 13.4, std('#b98a5e')); plinth.position.set(0, -0.6, -0.9); world.add(plinth);
  var top = box(32.8, 0.12, 12.6, std('#f3eadc')); top.position.set(0, -0.06, -0.9); world.add(top);

  var labelMats = [];
  LANES.forEach(function (l) {
    var mat = box(LANE_W, 0.05, LANE_Z1 - LANE_Z0, std(l.color)); mat.position.set(laneX[l.id], MAT_Y - 0.035, (LANE_Z0 + LANE_Z1) / 2); world.add(mat);
    var lm = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
    labelMats.push({ mat: lm, lane: l });
    var label = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W - 0.3, 0.92), lm);
    label.rotation.x = -PI / 2; label.position.set(laneX[l.id], MAT_Y + 0.006, LANE_Z0 + 0.62); world.add(label);
    // A pile tray.
    var tray = box(2.1, 0.03, 1.55, std(l.color, { roughness: 0.7 })); tray.position.set(laneX[l.id], MAT_Y + 0.015, PILE_Z); tray.material.color.multiplyScalar(0.86); world.add(tray);
  });
  function paintLabels() {
    labelMats.forEach(function (o) {
      o.mat.map = textTexture(512, 104, function (g, w, h) {
        var size = 64; g.font = '600 ' + size + 'px ' + MONO;
        while (g.measureText(o.lane.label).width > w - 16 && size > 20) { size -= 2; g.font = '600 ' + size + 'px ' + MONO; }
        g.fillStyle = 'rgba(31,27,22,0.8)'; g.textBaseline = 'middle'; g.fillText(o.lane.label, 8, h / 2 + 4);
      });
      o.mat.needsUpdate = true;
    });
  }

  // Cards.
  var cardTex = textTexture(256, 180, function (g, w, h) {
    g.fillStyle = '#fffaf2'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e2552d'; g.fillRect(0, 0, w, 26);
    g.fillStyle = 'rgba(31,27,22,0.55)';
    [56, 86, 116, 146].forEach(function (y, i) { g.fillRect(22, y, [190, 150, 176, 96][i], 10); });
  });
  var cardTop = new THREE.MeshStandardMaterial({ map: cardTex, roughness: 0.75, transparent: true });
  var cardSide = std('#efe5d6', { transparent: true });
  var cardMats = [cardSide, cardSide, cardTop, cardSide, cardSide, cardSide];
  var cards = {};
  CARDS.forEach(function (c) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(1.75, CARD_H, 1.25), cardMats.map(function (x) { return x.clone(); }));
    m.castShadow = true; m.receiveShadow = true; world.add(m); cards[c] = m;
  });

  // Agents: small robots with a coloured visor and an antenna that blinks while they work.
  var bodyMat = std('#f6f1e8', { roughness: 0.55 });
  var darkMat = std('#2c2722', { roughness: 0.6 });
  var robots = {};
  AGENTS.forEach(function (a) {
    var g = new THREE.Group();
    var accent = std(a.color, { roughness: 0.5 });
    var glow = new THREE.MeshStandardMaterial({ color: C(a.color), emissive: C(a.color), emissiveIntensity: 0.6, roughness: 0.4 });
    var body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.42, 0.62, 10), bodyMat); body.position.y = 0.6; body.castShadow = true; g.add(body);
    var belt = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.1, 10), accent); belt.position.y = 0.36; belt.castShadow = true; g.add(belt);
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 9), bodyMat); head.scale.set(1, 0.86, 0.94); head.position.y = 1.18; head.castShadow = true; g.add(head);
    var visor = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.17, 0.12), glow); visor.position.set(0, 1.2, 0.33); g.add(visor);
    var eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.02), darkMat); eyeL.position.set(-0.12, 1.2, 0.395); g.add(eyeL);
    var eyeR = eyeL.clone(); eyeR.position.x = 0.12; g.add(eyeR);
    var stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.32, 6), darkMat); stalk.position.set(0.12, 1.58, -0.12); g.add(stalk);
    var bulbMat = new THREE.MeshStandardMaterial({ color: C(a.color), emissive: C(a.color), emissiveIntensity: 0.4 });
    var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), bulbMat); bulb.position.set(0.12, 1.76, -0.12); g.add(bulb);
    function limb(x) {
      var pivot = new THREE.Group(); pivot.position.set(x, 0.82, 0);
      var arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 0.14), accent); arm.position.y = -0.2; arm.castShadow = true; pivot.add(arm); g.add(pivot); return pivot;
    }
    function foot(x) { var f = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.3), darkMat); f.position.set(x, 0.07, 0.02); f.castShadow = true; g.add(f); return f; }
    var sparks = [];
    for (var i = 0; i < 5; i++) {
      var s = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), glow); s.visible = false; g.add(s); sparks.push(s);
    }
    g.scale.setScalar(1.22);
    world.add(g);
    robots[a.id] = { g: g, armL: limb(-0.47), armR: limb(0.47), footL: foot(-0.16), footR: foot(0.16), head: head, visor: visor, bulb: bulbMat, glow: glow, sparks: sparks, eyes: [eyeL, eyeR] };
  });

  // ------------------------------------------------------------------ lights, camera, post
  var hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1); scene.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 1); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -22; sun.shadow.camera.right = 22; sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
  sun.shadow.camera.near = 5; sun.shadow.camera.far = 120; sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03; sun.shadow.radius = 3;
  scene.add(sun); scene.add(sun.target);
  var fog = new THREE.Fog(0xffffff, 80, 200); scene.fog = fog;

  var FOV = 15, DIR = new THREE.Vector3(0.18, 0.72, 1).normalize(), TARGET = new THREE.Vector3(0, -0.1, -0.4), DIST = 120;
  var camera = new THREE.PerspectiveCamera(FOV, 1.6, 30, 260);
  var sway = { x: 0, y: 0, tx: 0, ty: 0 };

  var PRESETS = {
    light: { sun: [-0.62, 0.9, 0.55], sunC: '#ffe2bd', sunI: 1.75, sky: '#d9e4f5', gnd: '#a68b6c', hemiI: 0.72, bg: '#eadcc8', fog: '#eadcc8', exp: 1.05, lo: [0.96, 0.98, 1.05], hi: [1.05, 1.0, 0.93], night: 0, vig: 0.5 },
    dark: { sun: [-0.45, 0.95, 0.6], sunC: '#9fb4ec', sunI: 0.5, sky: '#3a4672', gnd: '#191c26', hemiI: 0.5, bg: '#14161d', fog: '#14161d', exp: 1.18, lo: [0.9, 0.97, 1.12], hi: [1.05, 1.0, 0.92], night: 1, vig: 0.7 }
  };
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  var forced = params.get('theme');

  var pr = Math.min(2, window.devicePixelRatio || 1);
  if (CAPTURE) pr = Number(params.get('dpr') || 1);
  renderer.setPixelRatio(pr);
  var composer = null, tiltH, tiltV, grade;
  var TILT = {
    uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, focus: { value: 0.5 }, amount: { value: 1.0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; uniform vec2 dir; uniform float focus; uniform float amount; varying vec2 vUv;' +
      'void main(){ float b = amount * smoothstep(0.2, 0.62, abs(vUv.y - focus)); vec2 d = dir * b; vec4 s = texture2D(tDiffuse, vUv) * 0.227;' +
      's += (texture2D(tDiffuse, vUv + d) + texture2D(tDiffuse, vUv - d)) * 0.1946; s += (texture2D(tDiffuse, vUv + d * 2.0) + texture2D(tDiffuse, vUv - d * 2.0)) * 0.1216;' +
      's += (texture2D(tDiffuse, vUv + d * 3.0) + texture2D(tDiffuse, vUv - d * 3.0)) * 0.0541; s += (texture2D(tDiffuse, vUv + d * 4.0) + texture2D(tDiffuse, vUv - d * 4.0)) * 0.0162; gl_FragColor = s; }'
  };
  var GRADE = {
    uniforms: { tDiffuse: { value: null }, exposure: { value: 1 }, time: { value: 0 }, vig: { value: 0.5 }, grain: { value: 0.02 }, tintLo: { value: new THREE.Vector3(1, 1, 1) }, tintHi: { value: new THREE.Vector3(1, 1, 1) }, sat: { value: 1.06 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; uniform float exposure; uniform float time; uniform float vig; uniform float grain; uniform float sat; uniform vec3 tintLo; uniform vec3 tintHi; varying vec2 vUv;' +
      'vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }' +
      'void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb * exposure; c = aces(c); float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, sat); c *= mix(tintLo, tintHi, smoothstep(0.0, 0.8, l));' +
      'c = pow(max(c, 0.0), vec3(1.0 / 2.2)); vec2 d = vUv - 0.5; c *= 1.0 - vig * dot(d, d) * 1.4; float n = fract(sin(dot(vUv * vec2(1387.0, 911.0) + fract(time) * 37.0, vec2(12.9898, 78.233))) * 43758.5453); c += (n - 0.5) * grain; gl_FragColor = vec4(c, 1.0); }'
  };
  try {
    var rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat });
    composer = new THREE.EffectComposer(renderer, rt); composer.setPixelRatio(pr);
    composer.addPass(new THREE.RenderPass(scene, camera));
    tiltH = new THREE.ShaderPass(TILT); composer.addPass(tiltH);
    tiltV = new THREE.ShaderPass(TILT); composer.addPass(tiltV);
    grade = new THREE.ShaderPass(GRADE); composer.addPass(grade);
  } catch (e) { composer = null; renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; }

  function applyTheme() {
    var key = forced === 'dark' || forced === 'light' ? forced : (dark && dark.matches ? 'dark' : 'light');
    var p = PRESETS[key];
    sun.position.set(p.sun[0], p.sun[1], p.sun[2]).normalize().multiplyScalar(70); sun.color.copy(C(p.sunC)); sun.intensity = p.sunI;
    hemi.color.copy(C(p.sky)); hemi.groundColor.copy(C(p.gnd)); hemi.intensity = p.hemiI;
    scene.background.copy(C(p.bg)); fog.color.copy(C(p.bg)); ground.material.color.copy(C(p.bg)).multiplyScalar(key === 'dark' ? 1.25 : 0.96);
    AGENTS.forEach(function (a) { robots[a.id].glow.emissiveIntensity = 0.55 + p.night * 1.6; });
    if (grade) { grade.uniforms.exposure.value = p.exp; grade.uniforms.tintLo.value.fromArray(p.lo); grade.uniforms.tintHi.value.fromArray(p.hi); grade.uniforms.vig.value = p.vig; }
    else renderer.toneMappingExposure = p.exp;
    host.setAttribute('data-theme', key);
  }
  applyTheme();
  if (dark && dark.addEventListener) dark.addEventListener('change', applyTheme);

  // The page can reserve a band at the top of the host for its copy
  // (data-reserve-top, in pixels): the board is framed in the space below it.
  var W = 1, H = 1, RESERVE = 0;
  function resize() {
    W = host.clientWidth; H = host.clientHeight; if (!W || !H) return;
    RESERVE = Math.min(H * 0.55, Number(host.getAttribute('data-reserve-top') || 0));
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    var half = Math.atan(Math.tan(FOV * PI / 360) * camera.aspect);
    var need = 18.4 / Math.tan(half);
    var needV = 6.3 / Math.tan(FOV * PI / 360) * H / Math.max(1, H - RESERVE);
    DIST = Math.max(need, needV);
    camera.setViewOffset(W, H, 0, -RESERVE / 2 + H * 0.02, W, H);
    camera.updateProjectionMatrix();
    if (composer) { composer.setSize(W, H); tiltH.uniforms.dir.value.set(1 / W, 0); tiltV.uniforms.dir.value.set(0, 1 / H); }
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(host); else window.addEventListener('resize', resize);
  resize();

  if (!CAPTURE && !reduce && window.matchMedia('(pointer: fine)').matches) {
    host.addEventListener('pointermove', function (e) {
      var r = host.getBoundingClientRect();
      sway.tx = ((e.clientX - r.left) / r.width - 0.5) * 2; sway.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
    });
    host.addEventListener('pointerleave', function () { sway.tx = 0; sway.ty = 0; });
  }

  // ------------------------------------------------------------------ evaluation
  function smooth(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }
  function segAt(id, t) {
    var list = segs[id];
    for (var i = 0; i < list.length; i++) if (t < list[i].t1) return t < list[i].t0 ? null : list[i];
    return list[list.length - 1];
  }
  var tmp = new THREE.Vector3();
  function agentPose(id, t) {
    var s = segAt(id, t), x, z, yaw, state = 'idle', u = 0;
    if (!s) { var h = home(id); return { x: h[0], z: h[1], yaw: 0, state: 'idle', u: 0 }; }
    u = (t - s.t0) / Math.max(0.001, s.t1 - s.t0);
    var e = s.state === 'walk' ? smooth(u) : u;
    x = s.from[0] + (s.to[0] - s.from[0]) * e; z = s.from[1] + (s.to[1] - s.from[1]) * e;
    yaw = s.yaw; state = s.state;
    return { x: x, z: z, yaw: yaw, state: state, u: u, s: s };
  }
  function carrying(id, t) {
    for (var i = 0; i < CARDS.length; i++) { var st = cardStateAt(CARDS[i], t); if (st.cur.kind === 'carried' && st.cur.by === id) return true; }
    return false;
  }
  function cardStateAt(c, t) {
    var tl = cardTl[c], cur = tl[0], prev = null;
    for (var i = 1; i < tl.length; i++) { if (tl[i].t <= t) { prev = cur; cur = tl[i]; } else break; }
    return { cur: cur, prev: prev };
  }
  function pilePos(pile, idx) { return new THREE.Vector3(laneX[pile], MAT_Y + 0.03 + CARD_H / 2 + idx * STACK, PILE_Z); }
  function carriedPos(by, t) {
    var p = agentPose(by, t); return new THREE.Vector3(p.x, 2.38 + bob(p, t), p.z);
  }
  function bob(p, t) { return p.state === 'walk' ? Math.abs(Math.sin(t * 9.5)) * 0.09 : 0; }
  function posOf(st, t) {
    if (!st) return null;
    if (st.kind === 'pile' || st.kind === 'spawn') return pilePos(st.pile, stackIndex(st.pile, st._card, t, st.idx));
    if (st.kind === 'carried') return carriedPos(st.by, t);
    return null;
  }

  function layoutCard(c, t) {
    var m = cards[c], st = cardStateAt(c, t), cur = st.cur, prev = st.prev;
    var alpha = 1, pos, rotY = 0;
    if (cur.kind === 'hidden') { m.visible = false; return; }
    m.visible = true;
    if (cur.kind === 'gone') {
      var g = (t - cur.t) / 0.9; if (g >= 1) { m.visible = false; return; }
      pos = posOf(prev, cur.t) || pilePos('merged', 0); pos.y += smooth(g) * 1.2; alpha = 1 - smooth(g);
    } else if (cur.kind === 'spawn') {
      var k = (t - cur.t) / 0.75, target = pilePos(cur.pile, cur.idx);
      pos = target.clone();
      if (k < 1) { var fall = 1 - k; pos.y += 4.5 * fall * fall - Math.sin(Math.min(1, k * 1.25) * PI) * 0.0; rotY = fall * 0.8; alpha = smooth(k * 3); }
    } else {
      pos = posOf(cur, t);
      var dt = t - cur.t;
      if (prev && dt < 0.38 && cur.t > 0) {
        var a = posOf(prev, cur.t), w = smooth(dt / 0.38);
        if (a) { pos = a.clone().lerp(pos, w); pos.y += Math.sin(w * PI) * 0.35; }
      }
      if (cur.kind === 'carried') { var cp = agentPose(cur.by, t); rotY = cp.yaw; }
    }
    m.position.copy(pos); m.rotation.set(0, rotY, 0);
    for (var i = 0; i < m.material.length; i++) { m.material[i].opacity = alpha; }
  }

  function layoutRobot(a, t) {
    var r = robots[a.id], p = agentPose(a.id, t), g = r.g;
    var carry = carrying(a.id, t);
    var b = bob(p, t);
    g.position.set(p.x, b, p.z);
    // Turn smoothly from the heading the segment starts with.
    var yaw = p.yaw;
    if (p.s) { var k = smooth(Math.min(1, (t - p.s.t0) / 0.32)); yaw = p.s.start + angleDiff(p.s.start, p.s.yaw) * k; }
    g.rotation.y = yaw;
    var swing = p.state === 'walk' ? Math.sin(t * 9.5) * 0.55 : 0;
    r.footL.position.z = 0.02 + swing * 0.16; r.footR.position.z = 0.02 - swing * 0.16;
    r.footL.position.y = 0.07 + Math.max(0, swing) * 0.06; r.footR.position.y = 0.07 + Math.max(0, -swing) * 0.06;
    if (carry) { r.armL.rotation.set(PI - 0.15, 0, 0.18); r.armR.rotation.set(PI - 0.15, 0, -0.18); }
    else if (p.state === 'reach') { var q = Math.sin(p.u * PI); r.armL.rotation.set(-1.2 * q, 0, 0); r.armR.rotation.set(-1.2 * q, 0, 0); }
    else if (p.state === 'work') { r.armL.rotation.set(-0.9 + Math.sin(t * 14) * 0.25, 0, 0); r.armR.rotation.set(-0.9 + Math.sin(t * 14 + 1.7) * 0.25, 0, 0); }
    else { r.armL.rotation.set(-swing * 0.6, 0, 0.06); r.armR.rotation.set(swing * 0.6, 0, -0.06); }
    r.head.rotation.y = p.state === 'idle' ? Math.sin(t * 0.7 + a.home) * 0.18 : 0;
    var working = p.state === 'work';
    r.bulb.emissiveIntensity = working ? (Math.sin(t * 16) > 0 ? 2.6 : 0.4) : 0.5;
    var blink = ((t + a.home * 0.37) % 3.7) < 0.12;
    r.eyes[0].scale.y = r.eyes[1].scale.y = blink ? 0.15 : 1;
    r.sparks.forEach(function (s, i) {
      s.visible = working;
      if (!working) return;
      var ph = ((t * 1.3 + i / r.sparks.length) % 1);
      s.position.set(Math.sin(i * 2.4) * 0.45, 0.85 + ph * 1.1, 0.42 + Math.cos(i * 2.4) * 0.15);
      s.scale.setScalar(1 - ph);
      s.rotation.set(t * 3 + i, t * 2, 0);
    });
  }
  function angleDiff(a, b) { var d = (b - a) % (2 * PI); if (d > PI) d -= 2 * PI; if (d < -PI) d += 2 * PI; return d; }

  // ------------------------------------------------------------------ overlay: names, bubbles, tape
  var nameEls = {}, bubbleEls = {};
  AGENTS.forEach(function (a) {
    var n = document.createElement('div'); n.className = 'agent-name'; n.textContent = a.id; n.style.setProperty('--agent', a.color); overlay.appendChild(n); nameEls[a.id] = n;
    var b = document.createElement('div'); b.className = 'bubble'; b.style.setProperty('--agent', a.color); overlay.appendChild(b); bubbleEls[a.id] = b;
  });
  function project(x, y, z) {
    tmp.set(x, y, z).project(camera);
    return { x: (tmp.x * 0.5 + 0.5) * W, y: (-tmp.y * 0.5 + 0.5) * H };
  }
  function layoutOverlay(t) {
    var placed = [];
    AGENTS.forEach(function (a) {
      var p = agentPose(a.id, t);
      var foot = project(p.x, -0.05, p.z + 0.6);
      var n = nameEls[a.id]; n.style.transform = 'translate(' + foot.x.toFixed(1) + 'px,' + foot.y.toFixed(1) + 'px) translate(-50%, 0)';
      var active = null;
      for (var i = 0; i < bubbles.length; i++) { var bb = bubbles[i]; if (bb.agent === a.id && t >= bb.t0 && t < bb.t1) active = bb; }
      var el = bubbleEls[a.id];
      if (active) {
        var headY = carrying(a.id, t) ? 2.85 : 2.45;
        var hp = project(p.x, headY, p.z);
        if (el.textContent !== active.text) el.textContent = active.text;
        el.className = 'bubble on ' + active.kind;
        var age = t - active.t0, left = active.t1 - t, s = Math.min(1, age / 0.18, left / 0.18);
        placed.push({ el: el, x: hp.x, y: hp.y, s: s, w: el.offsetWidth, h: el.offsetHeight });
      } else if (el.className !== 'bubble') { el.className = 'bubble'; el.style.opacity = '0'; }
    });
    // Lift a bubble above any earlier one it would cover, so two agents
    // talking at once stay readable.
    placed.sort(function (a, b) { return b.y - a.y; });
    placed.forEach(function (b, i) {
      for (var j = 0; j < i; j++) {
        var o = placed[j];
        if (Math.abs(b.x - o.x) < (b.w + o.w) / 2 + 6 && Math.abs(b.y - o.y) < b.h + 8) b.y = o.y - o.h - 10;
      }
      b.el.style.opacity = String(b.s);
      b.el.style.transform = 'translate(' + b.x.toFixed(1) + 'px,' + b.y.toFixed(1) + 'px) translate(-50%, -100%) scale(' + (0.85 + 0.15 * b.s).toFixed(3) + ')';
    });
  }
  var tapeShown = -1;
  function layoutTape(t) {
    if (!tapeEl) return;
    var n = 0; while (n < tape.length && tape[n].t <= t) n++;
    if (n === tapeShown) return;
    tapeShown = n;
    var from = Math.max(0, n - 7);
    tapeEl.textContent = '';
    for (var i = from; i < n; i++) {
      var e = tape[i], li = document.createElement('li');
      if (i === n - 1) li.className = 'new';
      if (e.bad) li.className += ' bad';
      var h = document.createElement('span'); h.className = 'h'; h.textContent = e.hash + '...json'; li.appendChild(h);
      var k = document.createElement('span'); k.className = 'k'; k.textContent = e.kind; li.appendChild(k);
      var a = document.createElement('span'); a.className = 'a'; a.textContent = e.actor; a.style.setProperty('--agent', agentById[e.actor].color); li.appendChild(a);
      if (e.note) { var nn = document.createElement('span'); nn.className = 'n'; nn.textContent = e.note; li.appendChild(nn); }
      tapeEl.appendChild(li);
    }
    if (n === 0) { var li0 = document.createElement('li'); li0.className = 'idle'; li0.textContent = 'watching .board/events/ ...'; tapeEl.appendChild(li0); }
  }

  // ------------------------------------------------------------------ frame
  // The loop is seamless: at its end A, D and E sit on the todo pile exactly
  // where A, B and C sit at its start, and every agent is back home.
  function renderAt(T, wall) {
    var t = ((T % LOOP) + LOOP) % LOOP;
    CARDS.forEach(function (c) { layoutCard(c, t); });
    AGENTS.forEach(function (a) { layoutRobot(a, t); });
    sway.x += (sway.tx - sway.x) * 0.05; sway.y += (sway.ty - sway.y) * 0.05;
    var dir = DIR.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -sway.x * 0.06);
    dir.y += sway.y * 0.03; dir.normalize();
    camera.position.copy(TARGET).addScaledVector(dir, DIST); camera.lookAt(TARGET);
    camera.near = DIST - 40; camera.far = DIST + 90; camera.updateProjectionMatrix();
    fog.near = DIST + 15; fog.far = DIST + 110;
    camera.updateMatrixWorld();
    layoutOverlay(t);
    layoutTape(t);
    if (composer) {
      tiltH.uniforms.amount.value = 1.35; tiltV.uniforms.amount.value = 1.35;
      grade.uniforms.time.value = wall === undefined ? t : wall;
      composer.render();
    } else renderer.render(scene, camera);
  }

  var fontsReady = (document.fonts && document.fonts.load) ? Promise.all([document.fonts.load('600 64px "Martian Mono"')]).catch(function () {}) : Promise.resolve();
  var ready = fontsReady.then(function () { paintLabels(); host.classList.add('ready'); });

  var START = 0.0;
  var visible = true;
  if (window.IntersectionObserver) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }).observe(host);
  var clock = new THREE.Clock(), elapsed = START;
  function loop() {
    var dt = Math.min(0.05, clock.getDelta());
    if (visible && !document.hidden) { elapsed += dt; renderAt(elapsed, elapsed); }
    requestAnimationFrame(loop);
  }
  ready.then(function () {
    if (CAPTURE) return;
    if (reduce) { renderAt(24.6); return; }
    requestAnimationFrame(loop);
  });

  window.agentboardDiorama = { resize: resize, ready: ready, render: function (t) { renderAt(t, t); }, LOOP: LOOP, tape: tape };
})();
