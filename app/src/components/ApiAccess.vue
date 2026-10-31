<script setup lang="ts">
import { ref } from 'vue';
import { exportFile, Notify } from 'quasar';
import { signOut } from 'firebase/auth';
import { auth, emulator } from '../boot/firebase';
import { useWorkspace } from '../stores/workspace';
const workspace = useWorkspace();
const open = defineModel<boolean>({ required: true });
const busy = ref(false);
const projectId = auth.app.options.projectId;
const apiUrl = emulator
  ? `http://127.0.0.1:5001/${projectId}/australia-southeast1/api/v1`
  : `https://australia-southeast1-${projectId}.cloudfunctions.net/api/v1`;
async function downloadCredentials() {
  busy.value = true;
  try {
    if (!auth.currentUser) throw new Error('Sign in first.');
    const idToken = await auth.currentUser.getIdToken(true);
    const result = exportFile(
      'rundown-credentials.json',
      JSON.stringify(
        {
          apiUrl,
          apiKey: auth.app.options.apiKey,
          idToken,
          refreshToken: auth.currentUser.refreshToken,
          ...(emulator ? { authEmulatorUrl: 'http://127.0.0.1:9099' } : {}),
        },
        null,
        2,
      ),
      'application/json',
    );
    if (result !== true) throw new Error('Your browser blocked the download.');
    Notify.create({ type: 'positive', message: 'Credentials downloaded. Keep this file private.' });
  } catch (error) {
    Notify.create({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Download failed.',
    });
  } finally {
    busy.value = false;
  }
}
async function revoke() {
  busy.value = true;
  try {
    await workspace.flush();
    const token = await auth.currentUser?.getIdToken();
    const response = await fetch(`${emulator ? apiUrl : '/api/v1'}/auth_revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? 'Revocation failed.');
    await signOut(auth);
    open.value = false;
    Notify.create({
      type: 'positive',
      message: 'All refresh tokens revoked. Sign in again to continue.',
    });
  } catch (error) {
    Notify.create({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Revocation failed.',
    });
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <q-dialog v-model="open">
    <q-card style="width: 560px; max-width: 90vw">
      <q-card-section><h2 class="text-h6 q-my-none">API &amp; MCP access</h2></q-card-section>
      <q-card-section class="q-pt-none">
        <p>
          Connect an assistant or script using your Rundown account and organisation permissions.
        </p>
        <p>
          The credentials file grants access as you, including future sign-ins without a prompt.
          Keep it private, outside your repository, and only give it to tools you trust.
        </p>
        <q-input outlined readonly :model-value="apiUrl" label="API URL" />
        <p class="q-mt-md q-mb-none">
          To disconnect all tools, revoke your sign-in sessions below. This also signs you out on
          other devices and requires a sign-in within the last five minutes.
        </p>
      </q-card-section>
      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps label="Close" v-close-popup />
        <q-btn
          flat
          no-caps
          color="negative"
          label="Revoke all sessions"
          :disable="busy"
          @click="revoke"
        />
        <q-btn
          unelevated
          no-caps
          color="primary"
          label="Download credentials"
          :loading="busy"
          @click="downloadCredentials"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>
