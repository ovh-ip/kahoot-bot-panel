/* ============================================================
 * KAHOOT BOT ENGINE (v1.0)
 * Runs in the page context of https://kahoot.it
 * (Tampermonkey userscript or console paste).
 * Same-origin => Kahoot CORS passes, full protocol works.
 *
 * Config is read from window.KAHOOT_BOT_CONFIG.
 * See the GitHub Pages control panel to generate it.
 * ============================================================ */
(function () {
  'use strict';

  var CFG = Object.assign({
    pin: '',
    names: [],            // e.g. ["Bot1","Bot2"] ; empty => pattern is used
    namePattern: 'Bot #{i}',
    count: 1,
    joinStaggerMs: 400,
    quizId: '',           // UUID of the public quiz (best accuracy)
    quizName: '',          // ...or exact quiz title for auto-search
    searchLimit: 25,
    alwaysCorrect: true,
    fallbackChoice: 0,    // used when no answers known
    answerDelayMs: 600,   // base delay before answering
    answerJitterMs: 800,  // + random(0..jitter)
    twoFactor: '',        // e.g. "rbyg" to auto-answer 2FA, '' => ask in panel
    log: true
  }, (typeof window !== 'undefined' && window.KAHOOT_BOT_CONFIG) || {});

  if (!CFG.pin) { log('KAHOOT BOT: no PIN in config. Set window.KAHOOT_BOT_CONFIG.pin'); }
  CFG.pin = String(CFG.pin || '').replace(/\D/g, '');

  var COLORS = ['RED', 'BLUE', 'YELLOW', 'GREEN'];
  var bots = [];
  var sharedAnswers = null;   // resolved once per session, shared by all bots
  var answersPromise = null;
  var stopped = false;

  function log() {
    if (!CFG.log) return;
    var msg = Array.prototype.map.call(arguments, function (a) {
      return (typeof a === 'object') ? JSON.stringify(a) : String(a);
    }).join(' ');
    try { console.log('%c[KahootBot]', 'color:#7c3aed;font-weight:bold', msg); } catch (e) {}
    panelLog(msg);
  }

  /* ---------------- challenge solver ----------------
   * Modern Kahoot challenge format (from their own client):
   *   message = single-quoted string, offset = equation after '='
   *   decoded = replace each char: chr((code*pos + eval(offset)) % 77 + 48)
   * Legacy angular-style format is handled as a fallback. */
  function solvePyStyle(challenge) {
    // Same approach as the proven `kahoot` PyPI package:
    // strip tabs/unicode spaces, take offset equation after "offset = ",
    // take message after "this, '".
    var text = challenge.replace(/\t/g, '').replace(/[^\x00-\x7F]/g, '');
    var parts = text.split('offset = ');
    if (parts.length < 2) return null;
    var offset = eval(parts[1].split(';')[0]);
    if (typeof offset !== 'number' || isNaN(offset)) return null;
    var msgParts = text.split("this, '");
    if (msgParts.length < 2) return null;
    var message = msgParts[1].split("'")[0];
    if (!message) return null;
    var out = '';
    for (var position = 0; position < message.length; position++) {
      out += String.fromCharCode(((message.charCodeAt(position) * position + offset) % 77) + 48);
    }
    return out;
  }

  function solveModern(challenge) {
    var m = /'(\d*[a-z]*[A-Z]*)\w+'/.exec(challenge);
    if (!m) return null;
    var eqPos = challenge.indexOf('=');
    if (eqPos < 0) return null;
    var rest = challenge.slice(eqPos + 1);
    var semi = rest.indexOf(';');
    var offsetEquation = (semi >= 0 ? rest.slice(0, semi) : rest).trim();
    if (!offsetEquation) return null;
    var message = m[0].slice(1, -1);
    var decoded = message.replace(/./g, function (char, position) {
      return String.fromCharCode((char.charCodeAt(0) * position + eval(offsetEquation)) % 77 + 48);
    });
    return decoded;
  }

  function solveLegacy(challenge) {
    var c = challenge
      .replace(/(\u0009|\u2003)/mg, '')
      .replace(/this /mg, 'this')
      .replace(/ *\. */mg, '.')
      .replace(/ *\( */mg, '(')
      .replace(/ *\) */mg, ')')
      .replace('console.', '')
      .replace('this.angular.isObject(offset)', 'true')
      .replace('this.angular.isString(offset)', 'true')
      .replace('this.angular.isDate(offset)', 'true')
      .replace('this.angular.isArray(offset)', 'true');
    var solver = Function(
      'var _={replace:function(){var a=arguments;return (""+a[0]).replace(a[1],a[2]);}};' +
      'var log=function(){};return ' + c
    );
    return String(solver());
  }

  function solveChallenge(challenge) {
    var err = null;
    try {
      var py = solvePyStyle(challenge);
      if (py) return py;
    } catch (e) { err = e; }
    try {
      var modern = solveModern(challenge);
      if (modern) return modern;
    } catch (e) { err = e; }
    return solveLegacy(challenge);
  }

  function b64ToUtf8(b64) {
    var bin = atob(b64);
    if (typeof TextDecoder !== 'undefined') {
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }

  function xorTokens(headerTokenB64, solution) {
    // XOR over the UTF-8 decoded token — exactly like Kahoot's own
    // client, kahoot.js and the `kahoot` Python package do it.
    var decoded = b64ToUtf8(headerTokenB64);
    var out = '';
    for (var i = 0; i < decoded.length; i++) {
      out += String.fromCharCode(decoded.charCodeAt(i) ^ solution.charCodeAt(i % solution.length));
    }
    return out;
  }

  /* ---------------- quiz answers API ---------------- */
  function parseAnswers(quiz) {
    var answers = [];
    (quiz.questions || []).forEach(function (q) {
      if (q.type !== 'quiz' && q.type !== 'multiple_select_quiz' && q.type !== 'jumble') {
        answers.push(null); return;
      }
      var idx = [];
      (q.choices || []).forEach(function (ch, i) { if (ch.correct) idx.push(i); });
      if (q.type === 'jumble') {
        // jumble choices are stored in the correct order
        return void answers.push({ type: 'jumble', order: (q.choices || []).map(function (_, i) { return i; }) });
      }
      if (!idx.length) { answers.push(null); return; }
      if (q.type === 'multiple_select_quiz') answers.push({ type: 'multiple_select_quiz', choices: idx });
      else answers.push({ type: 'quiz', choice: idx[0] });
    });
    return answers;
  }

  function fetchQuizById(uuid) {
    return fetch('https://create.kahoot.it/rest/kahoots/' + encodeURIComponent(uuid))
      .then(function (r) {
        if (!r.ok) throw new Error('quiz fetch HTTP ' + r.status);
        return r.json();
      })
      .then(function (quiz) {
        log('Quiz loaded:', quiz.title, '| questions:', (quiz.questions || []).length);
        return { quiz: quiz, answers: parseAnswers(quiz) };
      });
  }

  function matchesQuiz(quiz, accepted) {
    var qs = quiz.questions || [];
    if (!accepted || qs.length !== accepted.length) return false;
    for (var i = 0; i < qs.length; i++) {
      var nChoices = (qs[i].choices || []).length;
      if (nChoices !== accepted[i]) return false;
    }
    return true;
  }

  function searchQuiz(name, accepted) {
    var url = 'https://create.kahoot.it/rest/kahoots/?query=' + encodeURIComponent(name) +
      '&cursor=0&limit=' + (CFG.searchLimit || 25) +
      '&topics=&grades=&orderBy=relevance&searchCluster=1&includeExtendedCounters=false';
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('search HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var entities = data.entities || [];
        log('Search "' + name + '": ' + entities.length + ' candidates');
        var chain = Promise.resolve(null);
        entities.forEach(function (e) {
          chain = chain.then(function (found) {
            if (found) return found;
            var card = e.card || {};
            if (accepted && card.number_of_questions !== accepted.length) return null;
            return fetchQuizById(card.uuid).then(function (res) {
              if (accepted && !matchesQuiz(res.quiz, accepted)) {
                log('Candidate "' + card.title + '" shape mismatch, skipping');
                return null;
              }
              log('Quiz matched: ' + card.title);
              return res.answers;
            }).catch(function () { return null; });
          });
        });
        return chain;
      });
  }

  // shared resolver: quizId > quizName(+accepted validation) > null
  function resolveAnswers(quizMeta) {
    if (answersPromise) return answersPromise;
    answersPromise = (function () {
      if (CFG.quizId) {
        log('Loading answers by quiz ID...');
        return fetchQuizById(CFG.quizId)
          .then(function (res) { return res.answers; })
          .catch(function (e) { log('Quiz ID failed:', e.message); return null; });
      }
      var name = CFG.quizName || (quizMeta && quizMeta.quizName);
      if (name) {
        log('Searching answers for quiz:', name);
        return searchQuiz(name, quizMeta && quizMeta.quizQuestionAnswers)
          .catch(function (e) { log('Search failed:', e.message); return null; });
      }
      log('No quizId/quizName — answers unknown, fallback mode.');
      return Promise.resolve(null);
    })().then(function (a) { sharedAnswers = a; return a; });
    return answersPromise;
  }

  /* ---------------- minimal Bayeux/cometd client ---------------- */
  function CometClient(wsUrl, onEvent) {
    this.wsUrl = wsUrl;
    this.onEvent = onEvent;
    this.msgId = 0;
    this.clientId = null;
    this.connected = false;
    this.ws = null;
  }

  CometClient.prototype._send = function (obj) {
    obj.id = String(++this.msgId);
    this.ws.send(JSON.stringify([obj]));
  };

  CometClient.prototype.connect = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(self.wsUrl); } catch (e) { reject(e); return; }
      self.ws = ws;
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; try { ws.close(); } catch (e) {} reject(new Error('handshake timeout')); }
      }, 15000);
      ws.onopen = function () {
        self._send({
          channel: '/meta/handshake', version: '1.0', minimumVersion: '1.0',
          supportedConnectionTypes: ['websocket', 'long-polling'],
          advice: { timeout: 60000, interval: 0 }
        });
      };
      ws.onerror = function () {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('websocket error')); }
      };
      ws.onclose = function () { self.connected = false; self.onEvent({ _sys: 'close' }); };
      ws.onmessage = function (ev) {
        var msgs;
        try { msgs = JSON.parse(ev.data); } catch (e) { return; }
        msgs.forEach(function (m) { self._handle(m, resolve, reject, settled, function () { settled = true; clearTimeout(timer); }); });
      };
    });
  };

  CometClient.prototype._handle = function (m, resolve, reject, settled, settle) {
    var self = this;
    if (m.channel === '/meta/handshake') {
      if (m.successful && m.clientId) {
        this.clientId = m.clientId;
        this.connected = true;
        ['/service/controller', '/service/player', '/service/status'].forEach(function (ch) {
          self._send({ channel: '/meta/subscribe', clientId: self.clientId, subscription: ch });
        });
        self._connect();
        settle(); resolve(self);
      } else {
        settle(); reject(new Error('handshake failed: ' + JSON.stringify(m)));
      }
      return;
    }
    if (m.channel === '/meta/connect') {
      if (this.connected) setTimeout(function () { self._connect(); }, 0);
      // fall through: connect replies may also carry data messages
    }
    if (m.channel && m.channel.indexOf('/service/') === 0 && m.data) {
      this.onEvent(m);
    }
  };

  CometClient.prototype._connect = function () {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
    this._send({ channel: '/meta/connect', clientId: this.clientId, connectionType: 'websocket' });
  };

  CometClient.prototype.publish = function (channel, data) {
    this._send({ channel: channel, clientId: this.clientId, data: data });
  };

  CometClient.prototype.close = function () {
    this.connected = false;
    try { this.ws && this.ws.close(); } catch (e) {}
  };

  /* ---------------- single bot ---------------- */
  function Bot(name) {
    this.name = name;
    this.comet = null;
    this.state = 'idle';
    this.score = 0;
    this.rank = null;
  }

  Bot.prototype.setState = function (s, extra) {
    this.state = s;
    if (extra !== undefined) this.score = extra;
    panelRender();
  };

  Bot.prototype.run = function () {
    var self = this;
    if (stopped) return Promise.resolve();
    self.setState('reserve');
    log(self.name + ': reserving session...');
    return fetch('https://kahoot.it/reserve/session/' + CFG.pin + '/?' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('reserve HTTP ' + r.status + ' (wrong PIN or game not started?)');
        var token = r.headers.get('x-kahoot-session-token');
        var gameserver = r.headers.get('x-kahoot-gameserver');
        if (!token) throw new Error('no session token (bot protection?)');
        return r.json().then(function (body) { return { body: body, token: token, gameserver: gameserver }; });
      })
      .then(function (res) {
        var solution = solveChallenge(res.body.challenge);
        var sessionId = xorTokens(res.token, solution);
        var bases = [];
        if (res.gameserver) {
          bases.push(res.gameserver.indexOf('://') >= 0
            ? res.gameserver.replace(/\/+$/, '')
            : 'wss://' + res.gameserver);
        }
        bases.push('wss://play.kahoot.it', 'wss://kahoot.it');
        var attempt = function (i) {
          if (i >= bases.length) throw new Error('all websocket hosts failed');
          var url = bases[i] + '/cometd/' + CFG.pin + '/' + sessionId;
          log(self.name + ': connecting ' + bases[i] + ' ...');
          var comet = new CometClient(url, function (m) { self.onMessage(m); });
          return comet.connect().then(function () { self.comet = comet; return comet; })
            .catch(function (e) { log(self.name + ': ' + bases[i] + ' failed, trying next'); return attempt(i + 1); });
        };
        return attempt(0);
      })
      .then(function () {
        self.setState('joining');
        self.comet.publish('/service/controller', {
          gameid: CFG.pin, host: 'kahoot.it', name: self.name, type: 'login',
          content: JSON.stringify({ device: { userAgent: (typeof navigator !== 'undefined' ? navigator.userAgent : 'KahootBot/1.0'), screen: { width: 1920, height: 1080 } } })
        });
      })
      .catch(function (e) {
        log(self.name + ' ERROR: ' + e.message);
        self.setState('error');
      });
  };

  Bot.prototype.onMessage = function (m) {
    var self = this;
    if (m._sys === 'close') { self.setState('closed'); return; }
    var d = m.data || {};
    if (m.channel === '/service/controller' && d.type === 'loginResponse') {
      if (d.error) {
        log(self.name + ': login rejected: ' + (d.description || d.error));
        if (/duplicate/i.test(d.description || '')) {
          self.name = self.name + '_' + Math.floor(Math.random() * 999);
          log(self.name + ': retrying with new name...');
          setTimeout(function () { self.run(); }, 800);
        } else self.setState('rejected');
      }
      return;
    }
    if (m.channel !== '/service/player' || typeof d.id === 'undefined') return;
    var content = {};
    try { content = JSON.parse(d.content || '{}'); } catch (e) {}
    switch (d.id) {
      case 14: // NameAccept
        self.name = content.playerName || self.name;
        self.setState('lobby');
        log(self.name + ': joined lobby ✓');
        break;
      case 9: // QuizStart
        self.setState('quiz');
        log(self.name + ': quiz started' + (content.quizName ? ' — ' + content.quizName : ''));
        resolveAnswers(content).then(function (a) {
          log(a ? ('Answers ready (' + a.filter(Boolean).length + ' known)') : 'No answers — fallback mode');
        });
        break;
      case 2: // QuestionStart
        self.setState('question');
        self.scheduleAnswer(content);
        break;
      case 53: // RESET_TWO_FACTOR_AUTH
        self.handle2FA();
        break;
      case 52: // TWO_FACTOR_AUTH_CORRECT
        log(self.name + ': 2FA ok ✓');
        break;
      case 4: // TIME_UP
        break;
      case 3: // GAME_OVER
        self.setState('done');
        log(self.name + ': game over. Score: ' + self.score + (self.rank ? ' Rank: ' + self.rank : ''));
        break;
      case 10: // RESET / kicked
        self.setState('kicked');
        log(self.name + ': disconnected by host');
        break;
      case 7: // ANSWER_RESPONSE
        if (typeof content.totalScore === 'number') self.score = content.totalScore;
        if (content.rank) self.rank = content.rank;
        panelRender();
        break;
    }
  };

  Bot.prototype.pickAnswer = function (q) {
    var idx = (typeof q.questionIndex === 'number') ? q.questionIndex : 0;
    var type = (q.gameBlockType || q.type || 'quiz');
    var known = sharedAnswers && sharedAnswers[idx];
    if (CFG.alwaysCorrect && known) {
      if (known.type === 'multiple_select_quiz') return { choice: known.choices, type: type, q: idx };
      if (known.type === 'jumble') return { choice: known.order, type: type, q: idx };
      return { choice: known.choice, type: type, q: idx };
    }
    if (type === 'multiple_select_quiz') return { choice: [CFG.fallbackChoice || 0], type: type, q: idx };
    if (type === 'jumble') return { choice: [0, 1, 2, 3], type: type, q: idx };
    return { choice: (CFG.fallbackChoice || 0), type: type, q: idx };
  };

  Bot.prototype.scheduleAnswer = function (q) {
    var self = this;
    var delay = (CFG.answerDelayMs || 0) + Math.random() * (CFG.answerJitterMs || 0);
    var timeAvail = q.timeAvailable || 20000;
    delay = Math.min(delay, Math.max(200, timeAvail - 500));
    setTimeout(function () {
      if (stopped || !self.comet || !self.comet.connected) return;
      var a = self.pickAnswer(q);
      self.comet.publish('/service/controller', {
        gameid: CFG.pin, host: 'kahoot.it', type: 'message', id: 45,
        content: JSON.stringify({ choice: a.choice, questionIndex: a.q, meta: { lag: 30 }, type: a.type })
      });
      var label = Array.isArray(a.choice) ? a.choice.map(function (c) { return COLORS[c]; }).join('+') : COLORS[a.choice];
      log(self.name + ': Q' + (a.q + 1) + ' answered ' + label);
      self.setState('answered');
    }, delay);
  };

  Bot.prototype.handle2FA = function () {
    var self = this;
    var seq = CFG.twoFactor;
    if (!seq) {
      panelAsk2FA(function (s) { self.submit2FA(s); });
      return;
    }
    self.submit2FA(seq);
  };

  Bot.prototype.submit2FA = function (seq) {
    var map = { r: 0, b: 1, y: 2, g: 3 };
    var steps = String(seq).toLowerCase().split('').map(function (c) { return map[c]; }).filter(function (n) { return n !== undefined; });
    if (steps.length !== 4) { log(this.name + ': bad 2FA sequence, need 4 of r/b/y/g'); return; }
    this.comet.publish('/service/controller', {
      gameid: CFG.pin, host: 'kahoot.it', type: 'message', id: 50,
      content: JSON.stringify({ sequence: steps.join('') })
    });
    log(this.name + ': 2FA submitted');
  };

  /* ---------------- names ---------------- */
  function buildNames() {
    if (CFG.names && CFG.names.length) return CFG.names.slice(0, CFG.count || CFG.names.length);
    var out = [];
    var n = CFG.count || 1;
    for (var i = 1; i <= n; i++) {
      out.push(String(CFG.namePattern || 'Bot #{i}').split('#{i}').join(i));
    }
    return out;
  }

  /* ---------------- floating panel ---------------- */
  var panelEl = null, panelLogEl = null, panelBotsEl = null, panel2faEl = null;

  function ensurePanel() {
    if (panelEl || typeof document === 'undefined') return;
    panelEl = document.createElement('div');
    panelEl.id = 'kahoot-bot-panel';
    panelEl.setAttribute('style', 'position:fixed;top:12px;right:12px;width:320px;max-height:70vh;overflow:hidden auto;background:#1e1b2e;color:#fff;font:13px/1.45 system-ui,sans-serif;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);z-index:2147483647;border:1px solid #7c3aed');
    panelEl.innerHTML =
      '<div id="kbp-head" style="cursor:move;background:#7c3aed;padding:8px 12px;font-weight:700;display:flex;justify-content:space-between;align-items:center">' +
      '<span>🤖 Kahoot Bot</span><span><button id="kbp-hide" style="background:none;border:0;color:#fff;cursor:pointer">—</button> <button id="kbp-stop" style="background:#ef4444;border:0;color:#fff;border-radius:6px;padding:2px 8px;cursor:pointer">stop</button></span></div>' +
      '<div id="kbp-body" style="padding:8px 12px"><div id="kbp-bots" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px"></div>' +
      '<div id="kbp-2fa" style="display:none;margin-bottom:8px"><div>2FA (например rbyg):</div><div style="display:flex;gap:4px"><input id="kbp-2fa-in" style="flex:1;border-radius:6px;border:0;padding:4px 8px;color:#000"/><button id="kbp-2fa-go" style="background:#7c3aed;border:0;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer">OK</button></div></div>' +
      '<div id="kbp-log" style="font-size:11px;opacity:.9;white-space:pre-wrap;word-break:break-word"></div></div>';
    document.body.appendChild(panelEl);
    var head = panelEl.querySelector('#kbp-head');
    var sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    head.addEventListener('mousedown', function (e) { drag = true; sx = e.clientX; sy = e.clientY; ox = panelEl.offsetLeft; oy = panelEl.offsetTop; });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      panelEl.style.left = 'auto'; panelEl.style.right = 'auto';
      panelEl.style.left = (ox + e.clientX - sx) + 'px'; panelEl.style.top = (oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', function () { drag = false; });
    panelEl.querySelector('#kbp-hide').onclick = function () {
      var b = panelEl.querySelector('#kbp-body');
      b.style.display = b.style.display === 'none' ? '' : 'none';
    };
    panelEl.querySelector('#kbp-stop').onclick = function () {
      stopped = true;
      bots.forEach(function (b) { b.comet && b.comet.close(); });
      log('Stopped by user.');
    };
    panelLogEl = panelEl.querySelector('#kbp-log');
    panelBotsEl = panelEl.querySelector('#kbp-bots');
    panel2faEl = panelEl.querySelector('#kbp-2fa');
  }

  function panelLog(msg) {
    if (!panelLogEl) return;
    var line = document.createElement('div');
    line.textContent = msg;
    panelLogEl.appendChild(line);
    while (panelLogEl.children.length > 60) panelLogEl.removeChild(panelLogEl.firstChild);
    panelLogEl.scrollTop = panelLogEl.scrollHeight;
  }

  function panelRender() {
    if (!panelBotsEl) return;
    panelBotsEl.innerHTML = '';
    bots.forEach(function (b) {
      var s = document.createElement('span');
      var color = { idle: '#6b7280', reserve: '#f59e0b', joining: '#f59e0b', lobby: '#3b82f6', quiz: '#3b82f6', question: '#a855f7', answered: '#22c55e', done: '#22c55e', error: '#ef4444', rejected: '#ef4444', kicked: '#ef4444', closed: '#6b7280' }[b.state] || '#6b7280';
      s.setAttribute('style', 'background:' + color + ';border-radius:6px;padding:1px 7px;font-size:11px');
      s.textContent = b.name + (b.score ? ' · ' + b.score : '');
      s.title = b.state;
      panelBotsEl.appendChild(s);
    });
  }

  var twofaCb = null;
  function panelAsk2FA(cb) {
    twofaCb = cb;
    if (panel2faEl) panel2faEl.style.display = '';
    log('2FA required — enter sequence in panel (r/b/y/g).');
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'kbp-2fa-go' && twofaCb) {
        var v = document.getElementById('kbp-2fa-in').value;
        var cb = twofaCb; twofaCb = null;
        if (panel2faEl) panel2faEl.style.display = 'none';
        cb(v);
      }
    });
  }

  /* ---------------- main ---------------- */
  function main() {
    if (!CFG.pin) return;
    ensurePanel();
    var names = buildNames();
    log('Starting ' + names.length + ' bot(s) for PIN ' + CFG.pin);
    if (CFG.quizId) resolveAnswers(null);
    names.forEach(function (name, i) {
      setTimeout(function () {
        if (stopped) return;
        var b = new Bot(name);
        bots.push(b);
        panelRender();
        b.run();
      }, i * (CFG.joinStaggerMs || 400));
    });
  }

  // expose for tests (Node) and console tinkering
  var API = { config: CFG, solveChallenge: solveChallenge, solveModern: solveModern, solveChallengeLegacy: solveLegacy, parseAnswers: parseAnswers, matchesQuiz: matchesQuiz, xorTokens: xorTokens, Bot: Bot, main: main, buildNames: buildNames };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else { window.KahootBot = API; }

  if (typeof window !== 'undefined' && window.KAHOOT_BOT_AUTORUN !== false && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
    else main();
  }
})();
