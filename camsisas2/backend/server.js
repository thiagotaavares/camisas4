
/**
 * ============================================================
 *  ARENA DO HEXA — Backend de pagamento PIX (VeoPag)
 * ============================================================
 *
 *  Servidor "escondido" que guarda as credenciais da VeoPag e
 *  gera as cobranças PIX com segurança. A página fala só com
 *  este backend — nunca direto com a VeoPag.
 *
 *  Rotas:
 *   POST /api/criar-pix     → cria a cobrança PIX (valor calculado AQUI)
 *   POST /api/webhook       → recebe da VeoPag o aviso "pago"
 *   GET  /api/status/:id    → a página pergunta "já pagou?"
 *   GET  /api/health        → teste de vida
 *
 *  Docs VeoPag: https://veopag.readme.io/docs
 *   • Login:    POST /api/auth/login  {client_id, client_secret} -> {token} (1h)
 *   • Depósito: POST /api/payments/deposit (Bearer) -> qrCodeResponse.qrcode
 *   • Webhook:  type=Deposit, status=COMPLETED
 *
 *  Rodar:  npm install && npm start
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();

/* ---------- Configuração (.env) ----------
 * Aceita nomes VEOPAG_* (preferidos). Por compatibilidade, também
 * lê os antigos BSPAY_* caso você ainda não tenha renomeado na Render. */
const env = process.env;
const VEOPAG_CLIENT_ID     = env.VEOPAG_CLIENT_ID     || env.BSPAY_CLIENT_ID;
const VEOPAG_CLIENT_SECRET = env.VEOPAG_CLIENT_SECRET || env.BSPAY_CLIENT_SECRET;
const VEOPAG_BASE_URL      = (env.VEOPAG_BASE_URL || 'https://api.veopag.com').replace(/\/+$/,'');
const VEOPAG_WEBHOOK_SECRET= env.VEOPAG_WEBHOOK_SECRET || env.BSPAY_WEBHOOK_SECRET || '';
const PUBLIC_URL           = env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/,'') : '';
const ALLOWED_ORIGIN       = env.ALLOWED_ORIGIN || '*';
const PORT                 = env.PORT || 3000;

if (!VEOPAG_CLIENT_ID || !VEOPAG_CLIENT_SECRET) {
  console.warn('\n⚠️  VEOPAG_CLIENT_ID / VEOPAG_CLIENT_SECRET não definidos. Configure o .env.\n');
}

const _origins = ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: _origins }));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

/* ============================================================
 *  E-MAIL (SMTP) — confirmação de pagamento para o cliente
 *  Configure no .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.
 *  Gmail: use uma "senha de app" (não a senha normal).
 *  Hostinger: host smtp.hostinger.com, porta 465.
 * ============================================================ */
const SMTP_HOST = env.SMTP_HOST || '';
const SMTP_PORT = parseInt(env.SMTP_PORT || '465', 10);
const SMTP_USER = env.SMTP_USER || '';
const SMTP_PASS = env.SMTP_PASS || '';
const SMTP_FROM = env.SMTP_FROM || (SMTP_USER ? `Arena do Hexa <${SMTP_USER}>` : '');
const LOJA_NOME = env.LOJA_NOME || 'Arena do Hexa';

let mailer = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // 465 = SSL; 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log('✉️  SMTP configurado:', SMTP_HOST);
} else {
  console.warn('✉️  SMTP não configurado — e-mails de confirmação desativados (defina SMTP_* no .env).');
}

async function enviarEmailConfirmacao(pedido) {
  if (!mailer || !pedido || !pedido.email) return;
  const valor = (pedido.amount != null ? pedido.amount : 0).toFixed(2).replace('.', ',');
  const nome = (pedido.nome || 'torcedor(a)').split(' ')[0];
  try {
    await mailer.sendMail({
      from: SMTP_FROM,
      to: pedido.email,
      subject: `✅ Pagamento confirmado — ${LOJA_NOME}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0B1410">
          <div style="background:#053D22;padding:22px;border-radius:14px 14px 0 0;text-align:center">
            <span style="display:inline-block;background:#FFD500;color:#053D22;font-weight:900;font-size:20px;padding:8px 13px;border-radius:9px">H</span>
            <div style="color:#fff;font-weight:800;letter-spacing:.04em;margin-top:10px">${LOJA_NOME.toUpperCase()}</div>
          </div>
          <div style="border:1px solid #e6e8e2;border-top:none;border-radius:0 0 14px 14px;padding:26px">
            <h2 style="margin:0 0 8px">Pagamento confirmado! 🎉</h2>
            <p style="color:#5C6660;margin:0 0 16px">Olá, ${nome}! Recebemos o seu pagamento e seu pedido já entrou em separação.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:8px 0;color:#5C6660">Pedido</td><td style="padding:8px 0;text-align:right;font-weight:700">${pedido.orderId || ''}</td></tr>
              <tr><td style="padding:8px 0;color:#5C6660">Valor pago</td><td style="padding:8px 0;text-align:right;font-weight:700">R$ ${valor}</td></tr>
            </table>
            <p style="color:#5C6660;font-size:13px;margin:18px 0 0">Em breve você receberá o código de rastreio. Obrigado por torcer com a gente! 🇧🇷</p>
          </div>
        </div>`,
    });
    console.log('✉️  E-mail de confirmação enviado para', pedido.email);
  } catch (e) {
    console.error('Falha ao enviar e-mail:', e.message);
  }
}

async function enviarEmailPedidoRecebido(pedido) {
  if (!mailer || !pedido || !pedido.email) return;
  const valor = (pedido.amount != null ? pedido.amount : 0).toFixed(2).replace('.', ',');
  const nome = (pedido.nome || 'torcedor(a)').split(' ')[0];
  try {
    await mailer.sendMail({
      from: SMTP_FROM,
      to: pedido.email,
      subject: `🛍️ Recebemos seu pedido — ${LOJA_NOME}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0B1410">
          <div style="background:#053D22;padding:22px;border-radius:14px 14px 0 0;text-align:center">
            <span style="display:inline-block;background:#FFD500;color:#053D22;font-weight:900;font-size:20px;padding:8px 13px;border-radius:9px">H</span>
            <div style="color:#fff;font-weight:800;letter-spacing:.04em;margin-top:10px">${LOJA_NOME.toUpperCase()}</div>
          </div>
          <div style="border:1px solid #e6e8e2;border-top:none;border-radius:0 0 14px 14px;padding:26px">
            <h2 style="margin:0 0 8px">Recebemos seu pedido! 👟</h2>
            <p style="color:#5C6660;margin:0 0 16px">Olá, ${nome}! Seu pedido foi registrado e estamos <b>aguardando a confirmação do pagamento via PIX</b>. Assim que o pagamento cair, você recebe outro e-mail de confirmação.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:8px 0;color:#5C6660">Pedido</td><td style="padding:8px 0;text-align:right;font-weight:700">${pedido.orderId || ''}</td></tr>
              <tr><td style="padding:8px 0;color:#5C6660">Valor</td><td style="padding:8px 0;text-align:right;font-weight:700">R$ ${valor}</td></tr>
            </table>
            <p style="color:#5C6660;font-size:13px;margin:18px 0 0">Se ainda não pagou, é só abrir o PIX e finalizar. O código expira conforme o tempo do QR Code. 🇧🇷</p>
          </div>
        </div>`,
    });
    console.log('✉️  E-mail de pedido recebido enviado para', pedido.email);
  } catch (e) {
    console.error('Falha ao enviar e-mail (pedido recebido):', e.message);
  }
}

/* ============================================================
 *  TABELA DE PREÇOS (fonte da verdade — fica no servidor!)
 *  Mantenha igual aos preços exibidos na página.
 * ============================================================ */
const PRECOS = { amarelo: 149.90, azul: 149.90 };
const CUPONS = { HEXA10: 0.10, COPA2026: 0.15 };
const FRETE = 19.90;

function calcularValor({ items = [], payment = 'pix', coupon = '' }) {
  let subtotal = 0, qtdTotal = 0;
  for (const it of items) {
    const preco = PRECOS[it && it.id];
    const qty = Math.max(1, Math.min(10, parseInt(it && it.qty, 10) || 1));
    if (!preco) continue;
    subtotal += preco * qty;
    qtdTotal += qty;
  }
  if (subtotal <= 0) return null;
  let desconto = 0;
  if (payment === 'pix') desconto += subtotal * 0.05;
  const cupom = CUPONS[String(coupon || '').toUpperCase()];
  if (cupom) desconto += subtotal * cupom;
  const totalSemFrete = Math.max(0, subtotal - desconto);
  const freteGratis = qtdTotal >= 2 || subtotal >= 199;
  const total = totalSemFrete + (freteGratis ? 0 : FRETE);
  return Math.round(total * 100) / 100;
}

/* ============================================================
 *  PERSISTÊNCIA SIMPLES EM ARQUIVO
 * ============================================================ */
const DB_FILE = path.join(__dirname, 'pedidos.json');
let pedidos = {};
try { if (fs.existsSync(DB_FILE)) pedidos = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {}; }
catch (e) { console.warn('Não foi possível ler pedidos.json:', e.message); }
let salvando = false;
function salvar() {
  if (salvando) return;
  salvando = true;
  setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(pedidos, null, 2)); }
    catch (e) { console.warn('Falha ao salvar pedidos.json:', e.message); }
    salvando = false;
  }, 50);
}

/* ============================================================
 *  TOKEN VeoPag (JWT, cache ~55min)
 *  POST /api/auth/login  {client_id, client_secret} -> { token }
 * ============================================================ */
let tokenCache = { value: null, exp: 0 };
async function getToken(forcar) {
  const agora = Date.now();
  if (!forcar && tokenCache.value && agora < tokenCache.exp) return tokenCache.value;
  const resp = await fetch(`${VEOPAG_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: VEOPAG_CLIENT_ID, client_secret: VEOPAG_CLIENT_SECRET }),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Falha na autenticação VeoPag (${resp.status}): ${txt}`);
  let json; try { json = JSON.parse(txt); } catch { throw new Error('Resposta de login inválida da VeoPag.'); }
  if (!json.token) throw new Error('Login VeoPag não retornou token.');
  tokenCache = { value: json.token, exp: agora + 55 * 60 * 1000 }; // 55 min
  return tokenCache.value;
}

/* ============================================================
 *  1) CRIAR COBRANÇA PIX  →  POST /api/criar-pix
 *     Body (da página): { items:[{id,qty}], payment, coupon, external_id, payer }
 *     O VALOR é calculado no servidor (anti-fraude).
 * ============================================================ */
async function criarDepositoVeoPag(token, { valor, orderId, payer }) {
  const resp = await fetch(`${VEOPAG_BASE_URL}/api/payments/deposit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: valor,
      external_id: orderId,
      clientCallbackUrl: PUBLIC_URL ? `${PUBLIC_URL}/api/webhook` : undefined,
      payer: {
        name: payer.name || 'Pagamento Digital',
        email: payer.email || 'comprador@arenadohexa.com.br',
        document: (payer.document || '').replace(/\D/g, ''),
        phone: payer.phone,
      },
    }),
  });
  const txt = await resp.text();
  let json; try { json = JSON.parse(txt); } catch { json = {}; }
  return { resp, json, txt };
}

app.post('/api/criar-pix', async (req, res) => {
  try {
    const { items, payment, coupon, external_id, payer = {} } = req.body || {};
    const valor = calcularValor({ items, payment, coupon });
    if (!valor || valor < 1) return res.status(400).json({ erro: 'Não foi possível calcular o valor do pedido.' });
    const orderId = String(external_id || `HEXA-${Date.now()}`).slice(0, 150);

    let token = await getToken();
    let { resp, json, txt } = await criarDepositoVeoPag(token, { valor, orderId, payer });

    // se o token tiver expirado/revogado (401), tenta uma vez com token novo
    if (resp.status === 401) {
      token = await getToken(true);
      ({ resp, json, txt } = await criarDepositoVeoPag(token, { valor, orderId, payer }));
    }

    if (!resp.ok && resp.status !== 200 && resp.status !== 201) {
      console.error('Erro VeoPag deposit:', resp.status, txt);
      return res.status(502).json({ erro: json.message || 'Não foi possível gerar o PIX agora.' });
    }

    // a VeoPag responde de 2 formas: 201 (nova) com qrCodeResponse, ou 200 (idempotente) plano
    const q = json.qrCodeResponse || json;
    const qrcode = q.qrcode;
    const transactionId = q.transactionId || q.transaction_id || json.transaction_id;
    if (!qrcode) {
      console.error('VeoPag não retornou qrcode:', txt);
      return res.status(502).json({ erro: 'A VeoPag não retornou o código PIX.' });
    }

    pedidos[orderId] = {
      status: 'pending',
      transaction_id: transactionId,
      amount: (q.amount != null ? q.amount : valor),
      email: (payer && payer.email) ? payer.email : null,
      nome: (payer && payer.name) ? payer.name : null,
      orderId,
      criado_em: Date.now(),
    };
    salvar();
    enviarEmailPedidoRecebido(pedidos[orderId]); // avisa o cliente: pedido recebido (fire-and-forget)

    return res.json({
      qrcode,
      transaction_id: transactionId,
      external_id: orderId,
      amount: (q.amount != null ? q.amount : valor),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Erro interno ao criar a cobrança.' });
  }
});

/* ============================================================
 *  2) WEBHOOK  →  POST /api/webhook
 *     A VeoPag chama quando o status muda. Confirmação: status COMPLETED.
 *     Responder 200.
 * ============================================================ */
function assinaturaValida(req) {
  if (!VEOPAG_WEBHOOK_SECRET) return true; // validação desligada se não há segredo
  try {
    const recebido = (req.get('x-signature') || req.get('x-webhook-signature') || req.get('x-secure-token') || '').trim();
    if (!recebido) return false;
    const esperado = crypto.createHmac('sha256', VEOPAG_WEBHOOK_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
    const a = Buffer.from(recebido), b = Buffer.from(esperado);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function ehPago(evt) {
  const s = String(evt.status || evt.transactionStatus || '').toUpperCase();
  return s === 'COMPLETED' || s === 'PAID' || s === 'APPROVED' || s === 'CONFIRMED';
}
function idDoPedido(evt) {
  return evt.external_id || evt.externalId || evt.external_reference ||
         (evt.data && (evt.data.external_id || evt.data.externalId)) || null;
}

app.post('/api/webhook', (req, res) => {
  if (!assinaturaValida(req)) {
    console.warn('⚠️ Webhook com assinatura inválida — ignorado.');
    return res.status(401).json({ ok: false });
  }
  const evt = req.body || {};
  if (ehPago(evt)) {
    const orderId = idDoPedido(evt);
    const pedido = orderId ? pedidos[orderId] : null;
    if (pedido) {
      pedido.status = 'paid';
      pedido.pago_em = Date.now();
      salvar();
      console.log(`✅ Pagamento confirmado: ${orderId}`);
      enviarEmailConfirmacao(pedido); // notifica o cliente por e-mail (fire-and-forget)
      // TODO: dar baixa no estoque, etc.
    } else {
      console.log('Webhook recebido sem pedido correspondente:', orderId);
    }
  }
  res.status(200).json({ ok: true });
});

/* ============================================================
 *  3) STATUS  →  GET /api/status/:external_id
 * ============================================================ */
app.get('/api/status/:external_id', (req, res) => {
  const pedido = pedidos[req.params.external_id];
  if (!pedido) return res.status(404).json({ status: 'desconhecido' });
  res.json({ status: pedido.status, transaction_id: pedido.transaction_id });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, servico: 'arena-do-hexa-pix', provedor: 'veopag' }));

app.listen(PORT, () => {
  console.log(`\n🟢 Backend Arena do Hexa (VeoPag) na porta ${PORT}`);
  console.log(`   Base VeoPag: ${VEOPAG_BASE_URL}`);
  console.log(`   Webhook:     ${PUBLIC_URL ? PUBLIC_URL + '/api/webhook' : '(defina PUBLIC_URL)'}`);
  console.log(`   Assinatura webhook: ${VEOPAG_WEBHOOK_SECRET ? 'ATIVADA' : 'desligada'}\n`);
});
