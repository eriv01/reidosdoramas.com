/**
 * RASTREAMENTO — LADO DO NAVEGADOR
 *
 * Carregue ANTES do script principal do checkout:
 *   <script src="/rastreio.js"></script>
 *
 * Define window.track(nome, custom, opcoes) — mesma assinatura que o
 * checkout ja usa, entao nada mais muda no HTML.
 *
 * Tres coisas que a versao anterior nao fazia:
 *
 *  1. Captura o fbclid da URL e manda pro servidor gravar o cookie _fbc.
 *     Sem isso, usuario com bloqueador vira venda sem anuncio associado.
 *  2. Guarda em fila o que falhou e reenvia depois. Perda de sinal no
 *     meio de um evento deixava o evento no chao.
 *  3. Descarrega a fila quando a aba vai pro fundo, com sendBeacon —
 *     que o navegador entrega mesmo depois da pagina fechar.
 */
(function () {
  'use strict';

  var FILA = 'rastreio_fila_v1';
  var IDS = 'rastreio_ids_v1';
  var ids = { fbp: '', fbc: '' };

  function cookie(nome) {
    var m = document.cookie.match(new RegExp('(^| )' + nome + '=([^;]+)'));
    return m ? decodeURIComponent(m[2]) : '';
  }

  function param(nome) {
    try { return new URLSearchParams(location.search).get(nome) || ''; }
    catch (e) { return ''; }
  }

  function guardado(chave, valor) {
    try {
      if (valor === undefined) return JSON.parse(localStorage.getItem(chave) || 'null');
      localStorage.setItem(chave, JSON.stringify(valor));
    } catch (e) { return null; }
  }

  function novoId() {
    return 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  /* O fbclid vale por 90 dias. Guardamos porque o usuario pode clicar no
     anuncio, sair, e voltar depois direto — sem o parametro na URL. */
  function fbclidAtual() {
    var atual = param('fbclid');
    if (atual) { guardado('fbclid_v1', { v: atual, t: Date.now() }); return atual; }
    var salvo = guardado('fbclid_v1');
    if (salvo && Date.now() - salvo.t < 90 * 864e5) return salvo.v;
    return '';
  }

  (function carregarIds() {
    var salvo = guardado(IDS) || {};
    ids.fbp = cookie('_fbp') || salvo.fbp || '';
    ids.fbc = cookie('_fbc') || salvo.fbc || '';
  })();

  function lerFila() { return guardado(FILA) || []; }
  function gravarFila(f) { guardado(FILA, f.slice(-25)); } /* teto: nao cresce sem limite */

  function enfileirar(payload) {
    var f = lerFila();
    f.push({ payload: payload, tentativas: 0 });
    gravarFila(f);
  }

  function enviar(payload) {
    return fetch('/api/meta-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).then(function (r) {
      if (!r.ok) throw new Error('status ' + r.status);
      return r.json();
    }).then(function (d) {
      /* O servidor devolve os ids que criou. Reaproveitamos para que o
         proximo evento fale do mesmo usuario. */
      if (d && d.fbp) ids.fbp = d.fbp;
      if (d && d.fbc) ids.fbc = d.fbc;
      guardado(IDS, ids);
      return d;
    });
  }

  function descarregarFila() {
    var f = lerFila();
    if (!f.length) return;
    gravarFila([]);
    f.forEach(function (item) {
      enviar(item.payload).catch(function () {
        if (item.tentativas < 3) {
          var atual = lerFila();
          atual.push({ payload: item.payload, tentativas: item.tentativas + 1 });
          gravarFila(atual);
        }
      });
    });
  }

  /* Ultima chance de entregar: sendBeacon sobrevive ao fechamento da aba. */
  function descarregarComBeacon() {
    var f = lerFila();
    if (!f.length || !navigator.sendBeacon) return;
    gravarFila([]);
    f.forEach(function (item) {
      try {
        navigator.sendBeacon(
          '/api/meta-event',
          new Blob([JSON.stringify(item.payload)], { type: 'application/json' })
        );
      } catch (e) {}
    });
  }

  function campo(id) {
    var el = document.getElementById(id);
    return el && el.value ? el.value.trim() : '';
  }

  /**
   * track(nome, custom, opcoes)
   *   opcoes.eventId      — reutiliza um id vindo do servidor (dedup)
   *   opcoes.somentePixel — nao manda pra CAPI (usado no Purchase, que
   *                         e responsabilidade exclusiva do webhook)
   */
  window.track = function (nome, custom, opcoes) {
    opcoes = opcoes || {};
    var eid = opcoes.eventId || novoId();

    try {
      if (window.fbq) fbq('track', nome, custom || {}, { eventID: eid });
    } catch (e) {}

    if (opcoes.somentePixel) return eid;

    var payload = {
      event_name: nome,
      event_id: eid,
      event_source_url: location.href,
      fbp: ids.fbp || cookie('_fbp'),
      fbc: ids.fbc || cookie('_fbc'),
      fbclid: fbclidAtual(),
      custom_data: custom || {},
      user: {
        email: campo('fEmail'),
        phone: campo('fCel').replace(/\D/g, ''),
        nome: campo('fNome')
      }
    };

    enviar(payload).catch(function () { enfileirar(payload); });
    return eid;
  };

  /** Ids atuais, para o criar-pix mandar junto na criacao do pagamento. */
  window.idsAtribuicao = function () {
    return {
      fbp: ids.fbp || cookie('_fbp'),
      fbc: ids.fbc || cookie('_fbc'),
      fbclid: fbclidAtual(),
      event_source_url: location.href
    };
  };

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) descarregarComBeacon();
    else descarregarFila();
  });
  window.addEventListener('pagehide', descarregarComBeacon);

  /* Primeiro contato: registra o clique do anuncio antes de qualquer
     outra coisa, para o _fbc existir no resto da sessao. */
  window.track('PageView');
  descarregarFila();
})();
