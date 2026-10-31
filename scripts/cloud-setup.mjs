// Uses the authenticated Firebase CLI session in memory; never prints access tokens.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const auth = require('firebase-tools/lib/auth');
const account = auth.getGlobalDefaultAccount();
if (!account) throw new Error('Run firebase login first.');
const tokens = await auth.getAccessToken(
  account.tokens.refresh_token,
  account.tokens.scopes ?? [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/firebase',
  ],
);
const token = tokens.access_token;
if (!token) throw new Error('Run firebase login --reauth first.');
const project = 'gathermesh-rundown';
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}
const mode = process.argv[2];
if (mode === 'storage-rules-access') {
  const info = await api(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`);
  const endpoint = `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`;
  const policy = await api(`${endpoint}:getIamPolicy`, {
    method: 'POST',
    body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
  });
  const role = 'roles/firebaserules.firestoreServiceAgent';
  const member = `serviceAccount:service-${info.projectNumber}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
  policy.bindings ??= [];
  let binding = policy.bindings.find((b) => b.role === role && !b.condition);
  if (!binding) policy.bindings.push((binding = { role, members: [] }));
  if (!binding.members.includes(member)) {
    binding.members.push(member);
    await api(`${endpoint}:setIamPolicy`, {
      method: 'POST',
      body: JSON.stringify({ policy, updateMask: 'bindings' }),
    });
  }
  console.log('Storage service agent can check Firestore membership for security rules.');
}
if (mode === 'inspect') {
  const accounts = await api('https://cloudbilling.googleapis.com/v1/billingAccounts');
  console.log(
    JSON.stringify({
      billingAccounts: (accounts.billingAccounts ?? []).map((a) => ({
        name: a.name,
        displayName: a.displayName,
        open: a.open,
      })),
    }),
  );
  const billing = await api(
    `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`,
  );
  console.log(JSON.stringify(billing));
}
if (mode === 'auth') {
  await api(
    `https://serviceusage.googleapis.com/v1/projects/${project}/services/identitytoolkit.googleapis.com:enable`,
    { method: 'POST', body: '{}' },
  );
  const config = await api(
    `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config?updateMask=signIn.email,authorizedDomains`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        signIn: { email: { enabled: true, passwordRequired: false } },
        authorizedDomains: ['localhost', `${project}.firebaseapp.com`, `${project}.web.app`],
      }),
    },
  );
  console.log(
    JSON.stringify({
      projectId: project,
      authorizedDomains: config.authorizedDomains,
      emailLink: config.signIn?.email,
    }),
  );
}
if (mode === 'enable') {
  const result = await api(
    `https://serviceusage.googleapis.com/v1/projects/${project}/services:batchEnable`,
    {
      method: 'POST',
      body: JSON.stringify({
        serviceIds: [
          'firestore.googleapis.com',
          'identitytoolkit.googleapis.com',
          'firebasestorage.googleapis.com',
        ],
      }),
    },
  );
  console.log(JSON.stringify(result));
}
if (mode === 'init-auth') {
  const result = await api(
    'https://identitytoolkit.googleapis.com/v2/projects/' +
      project +
      '/identityPlatform:initializeAuth',
    { method: 'POST', body: '{}' },
  );
  console.log(JSON.stringify(result));
}
if (mode === 'storage') {
  const result = await api(
    `https://firebasestorage.googleapis.com/v1alpha/projects/${project}/defaultBucket`,
    {
      method: 'POST',
      body: JSON.stringify({ location: 'australia-southeast1', storageClass: 'STANDARD' }),
    },
  );
  console.log(JSON.stringify(result));
}
if (mode === 'cors') {
  const result = await api(
    `https://storage.googleapis.com/storage/v1/b/${project}.firebasestorage.app`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        cors: [
          {
            origin: [
              `https://${project}.web.app`,
              `https://${project}.firebaseapp.com`,
              'http://localhost:9000',
            ],
            method: ['GET', 'HEAD'],
            responseHeader: ['Content-Type'],
            maxAgeSeconds: 3600,
          },
        ],
      }),
    },
  );
  console.log(JSON.stringify({ name: result.name, cors: result.cors }));
}
