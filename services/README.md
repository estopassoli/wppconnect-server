# WhatsApp Cold-Start Services

Serviços para reduzir consumo de RAM no WPPConnect Server usando estratégia de cold-start sessions.

## Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                     Seu Backend SaaS                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  /services/whatsappSessionManager.js              │   │
│  │  ─────────────────────────────────────────────────   │   │
│  │  • Gerencia sessões (Map em memória)               │   │
│  │  • Chama endpoints do WPPConnect via HTTP          │   │
│  │  • Retry logic para conexões                       │   │
│  │  • Cleanup automático de sessões inativas          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  /services/messageQueue.js                        │   │
│  │  ─────────────────────────────────────────────────   │   │
│  │  • Fila em memória para jobs de envio               │   │
│  │  • Controle de concorrência (max 3 sessões)        │   │
│  │  • Retry com backoff exponencial                    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ↓
              API do WPPConnect Server (existente)
              • /api/:session/start-session
              • /api/:session/close-session
              • /api/:session/send-message
```

## Instalação

Os arquivos já estão em `./services/`. Importe em seu backend:

```javascript
const SessionManager =
  require('./wppconnect-server/services/whatsappSessionManager').default;
// ou
const MessageQueue =
  require('./wppconnect-server/services/messageQueue').default;
```

## Configuração Básica

```javascript
// Inicializa Session Manager
const sessionManager = new SessionManager({
  baseURL: 'http://localhost:21465', // URL do WPPConnect
  secretKey: 'THISISMYSECURETOKEN', // Sua secret key
  maxActiveSessions: 3, // Máximo sessões ativas
  idleTimeout: 300000, // 5 minutos (300s)
  logger: console,
});

// Uso simples
const client = await sessionManager.ensureConnected('NERDWHATS_AMERICA');
await client.sendMessage('5511999999999', 'Olá!');
await sessionManager.closeIfNeeded('NERDWHATS_AMERICA');
```

## API Reference

### WhatsAppSessionManager

| Método                                             | Descrição                         | Retorno              |
| -------------------------------------------------- | --------------------------------- | -------------------- |
| `ensureConnected(sessionId, options)`              | Garante que sessão está conectada | `client`             |
| `closeIfNeeded(sessionId)`                         | Fecha sessão se estiver inativa   | `{ success }`        |
| `sendMessage(sessionId, number, message, options)` | Envia mensagem                    | `{ messageId }`      |
| `getStatus(sessionId)`                             | Status da sessão                  | `{ status, active }` |
| `cleanupIdleSessions(idleTime)`                    | Fecha sessões inativas            | `void`               |
| `getStats()`                                       | Estatísticas das sessões          | `object`             |

### MessageQueue

| Método                                         | Descrição            | Retorno                    |
| ---------------------------------------------- | -------------------- | -------------------------- |
| `enqueue(sessionId, number, message, options)` | Enfileira envio      | `{ jobId, queuePosition }` |
| `getStatus()`                                  | Status da fila       | `object`                   |
| `clearQueue()`                                 | Limpa fila e sessões | `void`                     |

## Exemplos de Uso

### 1. Envio Simples

```javascript
const SessionManager = require('./services/whatsappSessionManager').default;

const sessionManager = new SessionManager({
  baseURL: 'http://localhost:21465',
  secretKey: process.env.WPPCONNECT_SECRET_KEY,
  maxActiveSessions: 3,
});

// Enviar mensagem
async function sendReminder(sessionId, number, message) {
  try {
    // Garante conexão (abre Chromium se necessário)
    const client = await sessionManager.ensureConnected(sessionId);

    // Envia mensagem
    const result = await client.sendMessage(number, message);

    // Fecha sessão após envio
    await sessionManager.closeIfNeeded(sessionId);

    return result;
  } catch (error) {
    console.error(`Erro ao enviar para ${number}:`, error.message);
    throw error;
  }
}
```

### 2. Envio com Fila

```javascript
const MessageQueue = require('./services/messageQueue').default;

const queue = new MessageQueue({
  baseURL: 'http://localhost:21465',
  secretKey: process.env.WPPCONNECT_SECRET_KEY,
  maxSessions: 3,
  maxQueueSize: 100,
});

// Enviar na fila
async function sendWithQueue(sessionId, number, message) {
  const result = await queue.enqueue(sessionId, number, message);
  console.log(`Enfileirado: ${result.queuePosition} na fila`);
  return result;
}

// Monitorar fila
const status = queue.getStatus();
console.log(
  `Fila: ${status.queueLength} pendentes, ${status.availableSlots} slots`
);
```

### 3. Multi-Tenant (SaaS)

```javascript
class WhatsAppService {
  constructor() {
    this.sessionManager = new SessionManager({
      baseURL: 'http://localhost:21465',
      secretKey: process.env.WPPCONNECT_SECRET_KEY,
      maxActiveSessions: 5, // 5 sessões ativas simultâneas
      idleTimeout: 600000, // 10 minutos
    });
  }

  // Enviar lembrete para cliente
  async sendReminder(tenantId, clientPhone, reminderText) {
    const sessionId = this._getSessionId(tenantId);

    try {
      // Garante que sessão do tenant está ativa
      await this.sessionManager.ensureConnected(sessionId);

      // Envia mensagem
      const result = await this.sessionManager.sendMessage(
        sessionId,
        clientPhone,
        reminderText
      );

      // Fecha sessão se estiver inativa
      await this.sessionManager.closeIfNeeded(sessionId);

      return { success: true, ...result };
    } catch (error) {
      this.logger.error(`[${tenantId}] Erro: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  _getSessionId(tenantId) {
    // Transforma tenantId em sessionId válido
    return `tenant_${tenantId}`;
  }
}
```

### 4. Integração com Webhook

```javascript
app.post('/webhook/reminder/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  const data = req.body;

  const service = new WhatsAppService();

  const result = await service.sendReminder(
    tenantId,
    data.phoneNumber,
    data.message
  );

  if (result.success) {
    res.json({ success: true, messageId: result.messageId });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});
```

### 5. Rate Limiting

```javascript
// Implementa rate limiting por tenant
const MAX_REMINDERS_PER_HOUR = 100;
const reminderCounts = new Map();

async function sendWithRateLimit(tenantId, phoneNumber, message) {
  const now = Date.now();

  // Limpa contagens antigas (> 1 hora)
  for (const [id, count] of reminderCounts) {
    if (now - count > 3600000) {
      reminderCounts.delete(id);
    }
  }

  const currentCount = reminderCounts.get(tenantId) || 0;

  if (currentCount >= MAX_REMINDERS_PER_HOUR) {
    throw new Error('Limite de remeninders atingido');
  }

  // Incrementa contador
  reminderCounts.set(tenantId, currentCount + 1);

  // Envia
  const sessionManager = new SessionManager({...});
  await sessionManager.ensureConnected(tenantId);
  await sessionManager.sendMessage(tenantId, phoneNumber, message);
  await sessionManager.closeIfNeeded(tenantId);
}
```

## Monitoramento

```javascript
// Monitorar sessões
const stats = sessionManager.getStats();
console.log('Sessões ativas:', stats.activeSessions);
console.log('Slots disponíveis:', stats.availableSlots);
console.log('Timeout inatividade:', stats.idleTimeout);

// Monitorar fila
const queueStatus = queue.getStatus();
console.log('Fila:', queueStatus);
```

## Configurações Recomendadas

```javascript
const sessionManager = new SessionManager({
  baseURL: process.env.WPPCONNECT_URL,
  secretKey: process.env.WPPCONNECT_SECRET_KEY,
  maxActiveSessions: 3, // Comece com 3
  idleTimeout: 300000, // 5 minutos
});

const queue = new MessageQueue({
  baseURL: process.env.WPPCONNECT_URL,
  secretKey: process.env.WPPCONNECT_SECRET_KEY,
  maxSessions: 3,
  maxQueueSize: 50,
  processInterval: 1000,
  enableAutoCleanup: true,
  cleanupInterval: 30000,
});
```

## Comportamento das Sessões

### Ciclo de Vida

```
┌─────────────────┐
│   Token Save    │  (no disco)
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│   start-session │  → Abre Chromium
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  Aguarda QR Scan│  → Status: INITIALIZING
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│   CONNECTED     │  → Chromium ativo
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  Envia Mensagem │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  close-session  │  → Fecha Chromium
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  Token Preserved│  (para próxima vez)
└─────────────────┘
```

### RAM Consumption

```
Sem cold-start:   50 sessões × 150MB = 7.5GB RAM
Com cold-start:   50 sessões × 10MB (tokens) + 3 × 150MB = ~475MB RAM
```

## Erros Comuns

### "Sessão não encontrada"

```javascript
// Ocorre quando token não existe
await sessionManager.ensureConnected(sessionId, {
  phone: '5511999999999', // Necessário para criar nova sessão
});
```

### "Limite de sessões atingido"

```javascript
// Aguarde sessões liberarem ou aumente maxActiveSessions
sessionManager.setMaxActiveSessions(5);
```

### "Token não encontrado"

```bash
# Certifique-se de que o QR code foi escaneado e o token salvoh
# O token é salvo automaticamente após escaneamento bem-sucedido
```

## Configuração do WPPConnect Server para Cold-Start

**Importante!** Para o Chrome abrir e mostrar o QR Code no cold-start, configure no `src/config.ts`:

```typescript
createOptions: {
  browserArgs: [
    // REMOVA: --headless=true
    // REMOVA: --kiosk (pode esconder a janela)

    // ADICIONE:
    '--new-window',    // Força nova janela visível
    '--start-maximized', // Maximiza a janela
    '--window-position=0,0',

    // ... outros args de performance
  ],
  headless: false, // Força navegador não rodar em headless
}
```

### Flow do Cold-Start

1. **Primeiro uso da sessão:**

   - O Chrome abre com janela visível mostrando o QR Code
   - Escaneie o QR Code com seu celular
   - Token salvo no disco automaticamente

2. **Uso subsequente:**
   - Token carregado do disco
   - Chromium abre direto sem mostrar QR Code
   - Envio de mensagem
   - Chromium encerra automaticamente (cold-start!)

### Troubleshooting

### Chrome não abre / Janela não aparece

1. Verifique se `--headless=true` foi removido do `src/config.ts`
2. Verifique se `headless: false` está em `createOptions`
3. Verifique se `--kiosk` não está nos `browserArgs`
4. Reinicie o WPPConnect Server após alterações no config
5. Verifique logs do WPPConnect para erros de browser launch

### Sessão não conecta

1. Verifique se o QR code foi escaneado
2. Verifique firewall/proxy
3. Aumente timeout na config

### Mensagens falham

1. Verifique se sessão está conectada: `await sessionManager.getStatus(sessionId)`
2. Tente reiniciar sessão: `await sessionManager.ensureConnected(sessionId)`
3. Verifique logs do WPPConnect

### Mensagens falham

1. Verifique se sessão está conectada: `await sessionManager.getStatus(sessionId)`
2. Tente reiniciar sessão: `await sessionManager.ensureConnected(sessionId)`
3. Verifique logs do WPPConnect

## Performance

- **Início frio**: ~30-60s (primeira conexão)
- **Início quente**: <1s (já conectado)
- **Envio de mensagem**: <2s
- **Fechamento sessão**: ~1-2s

## Licença

Apache 2.0 (mesmo que WPPConnect Server)
