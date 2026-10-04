// index.js
// LTI 1.3 + ltijs + MongoDB Atlas + Brightspace APIs via Private Key JWT

require('dotenv').config();

const axios = require('axios');
const { createBrightspaceAuth } = require('./src/shared/auth');
const { databaseConfig } = require('./src/shared/database');
const { createBrightspaceClient, createBrightspaceGet, createActivityPut, hasScope } = require('./src/shared/client');
const { createAssignmentsClient } = require('./src/dates/activities/assignments');
const { createQuizzesClient } = require('./src/dates/activities/quizzes');
const { createDiscussionsClient } = require('./src/dates/activities/discussions');
const { createActivityDiscovery } = require('./src/dates/activityDiscovery');
const { createDiagnostics } = require('./src/dates/discoveryDiagnostics');
const { createActivityWriter } = require('./src/dates/activityWriters');
const { createActivityDates } = require('./src/dates/activityDates');
const { createCoursesClient } = require('./src/shared/courses');
const { createBulkJobs } = require('./src/shared/jobs');
const { createBulkStore } = require('./src/shared/store');
const { createBulkDates } = require('./src/shared/routes');
const { createHash } = require('node:crypto');
const { createSourceDeploymentClient } = require('./src/replication/client');
const { createDeploymentJobs } = require('./src/replication/jobs');
const { createDeploymentView } = require('./src/replication/view');
const lti = require('ltijs').Provider;
const {installUi,installPageShell}=require('./src/ui/install');
const {workspace}=require('./src/ui/page');
const {diagnosticForm}=require('./src/dates/discoveryDiagnostics');

// ===============================
// Variáveis de ambiente
// ===============================
const {
  // Infra / ltijs
  MONGODB_URL,
  LTI_KEY,
  PORT,

  // Brightspace LTI Platform (Registration LTI 1.3)
  BS_URL,
  BS_NAME,
  BS_CLIENT_ID,
  BS_DEPLOYMENT_ID,
  BS_AUTH_ENDPOINT,
  BS_TOKEN_ENDPOINT,   // ex.: https://auth.brightspace.com/core/connect/token
  BS_KEYSET_URL,

  // OAuth2 Client Credentials / Service User
  D2L_OAUTH2_CLIENT_ID,
  D2L_OAUTH2_PRIVATE_KEY,
  D2L_OAUTH2_KEY_ID,
  D2L_OAUTH2_TOKEN_ENDPOINT,
  D2L_OAUTH2_SCOPES,

  // Versões APIs LP/LE
  D2L_LE_VERSION
} = process.env;

const port = PORT || 3000;

// ===============================
// Validação básica de env
// ===============================
if (!MONGODB_URL || !LTI_KEY) {
  console.error('❌ ERRO: MONGODB_URL e LTI_KEY devem estar definidas no .env');
  process.exit(1);
}

const missingPlatformVariables = Object.entries({
  BS_URL, BS_AUTH_ENDPOINT, BS_TOKEN_ENDPOINT, BS_KEYSET_URL
}).filter(([, value]) => !value || !value.trim()).map(([name]) => name);

if (missingPlatformVariables.length) {
  console.error(`❌ Missing Brightspace LTI environment variables: ${missingPlatformVariables.join(', ')}. Configure them in Render and redeploy.`);
  process.exit(1);
}

if (!D2L_OAUTH2_CLIENT_ID || !D2L_OAUTH2_PRIVATE_KEY || !D2L_OAUTH2_KEY_ID || !D2L_OAUTH2_SCOPES) {
  throw new Error('Configure D2L_OAUTH2_CLIENT_ID, D2L_OAUTH2_PRIVATE_KEY, D2L_OAUTH2_KEY_ID e D2L_OAUTH2_SCOPES');
}

if (!D2L_LE_VERSION) {
  console.error('❌ ERRO: D2L_LE_VERSION devem estar definidas no .env');
  process.exit(1);
}

// Roots das APIs LP e LE
const leRoot = `${BS_URL}/d2l/api/le/${D2L_LE_VERSION}`;

const oauth = createBrightspaceAuth({
  clientId: D2L_OAUTH2_CLIENT_ID,
  scope: D2L_OAUTH2_SCOPES,
  kid: D2L_OAUTH2_KEY_ID,
  privateKeyPem: D2L_OAUTH2_PRIVATE_KEY,
  tokenEndpoint: D2L_OAUTH2_TOKEN_ENDPOINT,
  http: axios
});

const d2lGet = createBrightspaceGet({ http: axios, oauth, baseUrl: BS_URL, retries: 2 });

// ===============================
// Setup ltijs (LTI 1.3 Provider)
// ===============================
const {installDateUploadLimit}=require('./src/shared/uploadLimit');
lti.setup(
  LTI_KEY,
  databaseConfig(MONGODB_URL),
  {
    serverAddon: app => {
      installDateUploadLimit(app);
      installPageShell(app);
    },
    appRoute: '/',       // Target Link URI
    loginRoute: '/login',
    cookies: {
      secure: true,
      sameSite: 'None'
    },
    devMode: false
  }
);

installUi(lti,{shell:false});

// Public discovery endpoints must be reachable without an LTI launch.
lti.whitelist({ route: '/.well-known/brightspace-jwks.json', method: 'get' }, { route: '/ping', method: 'get' });
lti.app.get('/.well-known/brightspace-jwks.json', (req, res) => res.json(oauth.jwks));

// Registro da plataforma Brightspace
async function registerBrightspace() {
  const platform = await lti.registerPlatform({
    url: BS_URL,                        // Issuer
    name: BS_NAME || 'Brightspace',
    clientId: BS_CLIENT_ID,
    authenticationEndpoint: BS_AUTH_ENDPOINT,
    accesstokenEndpoint: BS_TOKEN_ENDPOINT,
    authConfig: {
      method: 'JWK_SET',
      key: BS_KEYSET_URL
    }
  });

  console.log('✅ Plataforma Brightspace registrada:', await platform.platformName());
}

// ===============================
// Handler do Launch LTI
// ===============================
const brightspace = createBrightspaceClient({ get: d2lGet, leRoot });
const discovery = createActivityDiscovery({
  assignments: createAssignmentsClient(brightspace),
  quizzes: createQuizzesClient(brightspace),
  discussions: createDiscussionsClient(brightspace)
});
const writers = Object.fromEntries(['assignment','quiz','discussionTopic'].map(type => [type,
  createActivityWriter({api:brightspace,type,put:createActivityPut({http:axios,oauth,leRoot,type})})]));
const writeEnabled = type => hasScope(D2L_OAUTH2_SCOPES, {assignment:'dropbox:folders:write',quiz:'quizzing:quizzes:write',discussionTopic:'discussions:topics:manage'}[type]);
const activityDates = createActivityDates({writers,deploymentId:BS_DEPLOYMENT_ID,writeEnabled});
const bulkStore = createBulkStore({uri:MONGODB_URL,namespace:createHash('sha256').update(`${BS_URL}|${BS_DEPLOYMENT_ID}`).digest('hex')});
const lpVersion = process.env.D2L_LP_VERSION || '1.53';
const sourceClient = createSourceDeploymentClient({api:brightspace,http:axios,oauth,baseUrl:BS_URL,lpVersion});
const deployEnabled = () => hasScope(D2L_OAUTH2_SCOPES,'manageCourses:deploy:manage') && hasScope(D2L_OAUTH2_SCOPES,'orgunits:course:update');
const deployment = createDeploymentJobs({client:sourceClient,enabled:deployEnabled});
const bulkJobs = createBulkJobs({store:bulkStore,discovery,writers,writeEnabled,deployment,
  courses:createCoursesClient({api:brightspace,baseUrl:BS_URL,lpVersion,sourceClient})});
const bulkDates = createBulkDates({jobs:bulkJobs,deploymentId:BS_DEPLOYMENT_ID,secret:LTI_KEY,writeEnabled});
const deploymentRoutes = createBulkDates({jobs:bulkJobs,deploymentId:BS_DEPLOYMENT_ID,secret:LTI_KEY,kind:'sourceDeployment',view:createDeploymentView({enabled:deployEnabled})});
const diagnostics = createDiagnostics({
  workspace: true,
  activityForm: res => workspace({
    dates:bulkDates.form(res),replication:deploymentRoutes.form(res),
    selected:res.locals.uiSection||'dates',
    history:`<div class="history-grid"><section class="panel"><span class="eyebrow">ACTIVITY DATES MANAGER</span><h3>Date Update Jobs</h3><p>See course validation, applied dates and read-back results.</p>${bulkDates.historyButton(res)}</section><section class="panel"><span class="eyebrow">SOURCE COURSES DEPLOYER</span><h3>Deployment Jobs</h3><p>Check source course deployment requests and activate course replicas after copy completion.</p>${deploymentRoutes.historyButton(res)}</section></div>`,
    tools:diagnosticForm(res.locals.ltik)+activityDates.form(res)
  }),
  client: discovery,
  deploymentId: BS_DEPLOYMENT_ID
});
lti.onConnect(diagnostics.launch);
lti.app.post('/workspace',(req,res)=>{res.locals.uiSection=['dates','replication','history'].includes(req.body?.section)?req.body.section:'dates';return diagnostics.launch(res.locals.token,req,res);});
// Not whitelisted: ltijs validates the LTI session before this handler runs.
lti.app.get('/diagnostics/activities', diagnostics.activities);
// Protected POST routes; preview/apply tickets are bound to the validated LTI session.
lti.app.post('/diagnostics/activity-dates/preview', activityDates.preview);
lti.app.post('/diagnostics/activity-dates/apply', activityDates.apply);
for (const action of ['preview','apply','status','cancel','history','report']) {
  lti.app.post(`/bulk/${action}`, bulkDates[action]);
}

for (const action of ['preview','apply','status','cancel','history','report','review','activate']) {
  lti.app.post(`/deploy/${action}`, deploymentRoutes[action]);
}

// Health-check
lti.app.get('/ping', (req, res) => {
  res.send('App LTI no Render está viva 🚀');
});

// ===============================
// Inicialização
// ===============================
const start = async () => {
  try {
    await lti.deploy({ port });
    const bulkTimer = setInterval(() => { void bulkJobs.tick(); }, 2000);
    bulkTimer.unref();
    if (!BS_DEPLOYMENT_ID?.trim()) {
      console.log('Setup mode: launches are blocked until BS_DEPLOYMENT_ID is configured. Key endpoints remain available.');
    }
    console.log(`🚀 Servidor LTI rodando na porta ${port}`);
    if (BS_CLIENT_ID && BS_CLIENT_ID.trim()) {
      await registerBrightspace();
    } else {
      console.log('Setup mode: key endpoints are available. Set BS_CLIENT_ID after creating the Brightspace LTI registration, then restart.');
    }
  } catch (err) {
    console.error('❌ Erro na inicialização:', err.message);
    process.exit(1);
  }
};

start();
