# Arena do Hexa — Backend de Pagamento PIX (VeoPag)

Este é o "servidor escondido" que guarda suas credenciais da VeoPag e gera as cobranças PIX de verdade. A sua página (`Arena do Hexa.html`) conversa **apenas** com este backend — nunca direto com a VeoPag.

> **Por que preciso disso?** A página roda no navegador do cliente, então qualquer um vê o código dela. Se as suas chaves secretas ficassem lá, qualquer pessoa poderia gerar cobranças em seu nome. O backend mantém as chaves em segurança.

---

## Como a API VeoPag funciona (resumo)

- **Login:** `POST https://api.veopag.com/api/auth/login` com `{client_id, client_secret}` → devolve um `token` (JWT) válido por 1 hora. O backend cacheia esse token por ~55 min.
- **Gerar PIX (depósito):** `POST /api/payments/deposit` (com `Authorization: Bearer token`) → devolve `qrCodeResponse.qrcode` (o PIX copia-e-cola).
- **Webhook:** quando o PIX é pago, a VeoPag faz um `POST` na `clientCallbackUrl` com `type=Deposit, status=COMPLETED`.

Tudo isso já está implementado no `server.js`.

---

## Atualizando seu serviço na Render (você já tem um no ar)

### 1. Atualize o `server.js` no GitHub
Substitua o conteúdo do `camisas/backend/server.js` pelo novo (e, opcionalmente, o `.env.example`). Commit → a Render republica sozinha.

### 2. Ajuste as variáveis de ambiente (aba *Environment* na Render)
| Variável | Valor |
|---|---|
| `VEOPAG_CLIENT_ID` | seu client_id da **VeoPag** |
| `VEOPAG_CLIENT_SECRET` | seu client_secret da **VeoPag** |
| `PUBLIC_URL` | a URL do seu backend (ex.: `https://camisas-96ii.onrender.com`) |
| `ALLOWED_ORIGIN` | `*` por enquanto (depois, o domínio do seu site) |

> O código também aceita os nomes antigos `BSPAY_CLIENT_ID`/`BSPAY_CLIENT_SECRET` como reserva — mas o ideal é renomear para `VEOPAG_*` e colocar os valores da VeoPag.

A base `https://api.veopag.com` já é o padrão (não precisa configurar `VEOPAG_BASE_URL`).

### 3. Teste
- `SUA_URL/api/health` → `{"ok":true,"provedor":"veopag"}`
- Na página: escolher camisa → Comprar → PIX → Finalizar → deve aparecer o QR Code real da VeoPag.

---

## Credenciais VeoPag
Gere em **https://dashboard.veopag.com/credentials** (após concluir o KYC). O `client_secret` só é exibido **uma vez** — guarde com segurança. Nunca coloque essas chaves no HTML/frontend.

---

## Webhook (confirmação automática)
Você **não precisa** cadastrar o webhook manualmente: o backend já envia a `clientCallbackUrl` (= `PUBLIC_URL/api/webhook`) em cada cobrança. Basta o `PUBLIC_URL` estar configurado na Render. Quando o PIX é pago, a VeoPag avisa, o backend marca o pedido como pago, e a tela do cliente vira "Aprovado" sozinha.

---

## Rodando localmente (opcional)
```bash
cd backend
cp .env.example .env      # preencha com suas chaves VeoPag
npm install
npm start                 # http://localhost:3000
```

---

## ⚠️ Checklist de produção

- [x] **Valor recalculado no servidor** — o `server.js` calcula o total pela tabela `PRECOS` (não confia no valor da página). **Mantenha `PRECOS` igual aos preços do site.**
- [x] **Persistência dos pedidos** — salvos em `pedidos.json`. Para alto volume, use um banco real (Postgres/Redis).
- [x] **Validação de assinatura do webhook** — pronta, porém **desligada** até você definir `VEOPAG_WEBHOOK_SECRET` (se a VeoPag fornecer um segredo de webhook).
- [ ] **Restringir o CORS** (`ALLOWED_ORIGIN`) ao seu domínio quando o site estiver no ar.
- [ ] **Disparar e-mail/WhatsApp e dar baixa no estoque** no webhook (`TODO` marcado no `server.js`).
- [ ] Conferir taxas e limites no painel da VeoPag.

> **Atualizou um preço na página?** Atualize também a tabela `PRECOS` no topo do `server.js` e publique de novo.
