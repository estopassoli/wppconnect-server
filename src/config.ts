import { ServerOptions } from './types/ServerOptions';

export default {
  secretKey: 'THISISMYSECURETOKEN',
  host: 'http://localhost',
  port: '21465',
  deviceName: 'Agenda-Expert',
  poweredBy: 'Agenda-Expert-Server',
  startAllSession: false,
  tokenStoreType: 'file',
  maxListeners: 15,
  customUserDataDir: './userDataDir/',
  webhook: {
    url: null,
    autoDownload: false,
    uploadS3: false,
    readMessage: false,
    allUnreadOnStart: false,
    listenAcks: false,
    onPresenceChanged: false,
    onParticipantsChanged: false,
    onReactionMessage: false,
    onPollResponse: false,
    onRevokedMessage: false,
    onLabelUpdated: false,
    onSelfMessage: false,
    ignore: ['status@broadcast'],
  },
  websocket: {
    autoDownload: false,
    uploadS3: false,
  },
  chatwoot: {
    sendQrCode: true,
    sendStatus: true,
  },
  archive: {
    enable: false,
    waitTime: 10,
    daysToArchive: 45,
  },
  log: {
    level: 'silly', // Before open a issue, change level to silly and retry a action
    logger: ['console', 'file'],
  },
  createOptions: {
    // Argumentos do navegador para cold-start sessions
    // --headless NÃO deve estar ativo para permitir visualização do QR Code
    browserArgs: [
      '--disable-web-security',
      '--no-sandbox',
      // Nota: REMOVIDO --headless=true para permitir visualização do QR Code
      // O QR Code será exibido na tela/aba do Chrome para escaneamento
      '--aggressive-cache-discard',
      '--disable-cache',
      '--disable-application-cache',
      '--disable-offline-load-stale-cache',
      '--disk-cache-size=0',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors',
      '--ignore-certificate-errors-spki-list',
      // Nota: O headless=true deve ser removido ou substituído por headless=false
      // para permitir que o QR Code seja exibido e escaneado
      '--disable-gpu', // Mantido para evitar issues em alguns sistemas
      // Argumentos para FORÇAR exibição da janela do Chrome:
      '--new-window', // Abre em nova janela visível (importante para cold-start)
      '--start-maximized', // Maximiza a janela
      '--window-position=0,0', // Posiciona no canto superior esquerdo
    ],
    /**
     * Example of configuring the linkPreview generator
     * If you set this to 'null', it will use global servers; however, you have the option to define your own server
     * Clone the repository https://github.com/Agenda-Expert-team/wa-js-api-server and host it on your server with ssl
     *
     * Configure the attribute as follows:
     * linkPreviewApiServers: [ 'https://www.yourserver.com/wa-js-api-server' ]
     */
    linkPreviewApiServers: null,

    /**
     * Set specific whatsapp version
     */
    // whatsappVersion: '2.xxxxx',

    // Opcional: Forçar headless false explicitamente (algumas versões do wppconnect exigem isso)
    headless: true,
  },
  mapper: {
    enable: false,
    prefix: 'tagone-',
  },
  db: {
    mongodbDatabase: 'tokens',
    mongodbCollection: '',
    mongodbUser: '',
    mongodbPassword: '',
    mongodbHost: '',
    mongoIsRemote: true,
    mongoURLRemote: '',
    mongodbPort: 27017,
    redisHost: 'localhost',
    redisPort: 6379,
    redisPassword: '',
    redisDb: 0,
    redisPrefix: 'docker',
  },
  aws_s3: {
    region: 'sa-east-1' as any,
    access_key_id: null,
    secret_key: null,
    defaultBucketName: null,
    endpoint: null,
    forcePathStyle: null,
  },
} as unknown as ServerOptions;
