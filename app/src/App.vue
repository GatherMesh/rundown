<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  GoogleAuthProvider,
  signInWithPopup,
  sendSignInLinkToEmail,
  signOut,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth, configured } from './boot/firebase';
import { useWorkspace } from './stores/workspace';
import { Dialog, Notify } from 'quasar';
import ApiAccess from './components/ApiAccess.vue';
const apiAccessOpen = ref(false);
const w = useWorkspace(),
  route = useRoute(),
  router = useRouter();
const busy = ref(false),
  email = ref(''),
  orgName = ref(''),
  sample = ref(true);
const nav = ['Sessions', 'Templates', 'Export', 'Email', 'People', 'Categories', 'Organisation'];
async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    w.fail(e);
  } finally {
    busy.value = false;
  }
}
async function emailLink() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value))
    throw new Error('Enter a valid email address.');
  await sendSignInLinkToEmail(auth, email.value, { url: location.origin, handleCodeInApp: true });
  localStorage.setItem('rundown-email', email.value);
  Notify.create({ type: 'positive', message: 'Sign-in link sent. Check your email.' });
}
function newOrg() {
  Dialog.create({
    title: 'New organisation',
    prompt: { model: '', label: 'Organisation name', isValid: (v) => v.trim().length > 0 },
    cancel: true,
  }).onOk((name: string) => void run(() => w.createTenant(name)));
}
</script>
<template>
  <router-view v-if="route.meta.public" />
  <div v-else class="app-shell">
    <header class="topbar">
      <a class="brand" href="/sessions"
        ><span class="brand-mark"><i></i><i></i><i></i></span>Rundown</a
      >
      <q-btn
        v-if="w.tenant"
        flat
        no-caps
        class="tenant-button"
        :label="w.tenant.name"
        icon-right="expand_more"
        ><q-menu
          ><q-list style="min-width: 220px"
            ><q-item
              v-for="tenant in w.tenants"
              :key="tenant.id"
              clickable
              v-close-popup
              @click="run(() => w.selectTenant(tenant.id))"
              ><q-item-section>{{ tenant.name }}</q-item-section></q-item
            ><q-separator /><q-item clickable v-close-popup @click="newOrg"
              ><q-item-section>+ New organisation</q-item-section></q-item
            ></q-list
          ></q-menu
        ></q-btn
      >
      <nav v-if="w.tenant" aria-label="Main navigation">
        <router-link
          v-for="n in nav"
          :key="n"
          :to="'/' + n.toLowerCase()"
          :class="{ active: (route.params.page || 'sessions') === n.toLowerCase() }"
          >{{ n }}</router-link
        >
      </nav>
      <div class="topbar-end">
        <span v-if="w.tenant" class="save-status" role="status">{{ w.status }}</span
        ><span v-if="w.emulator" class="local-label">Local emulator</span
        ><q-btn
          v-if="w.user"
          round
          flat
          class="avatar"
          :label="(w.user.displayName || 'You').slice(0, 2).toUpperCase()"
          ><q-menu
            ><q-list
              ><q-item
                ><q-item-section
                  >{{ w.user.email || 'Local producer' }}<small>{{ w.role }}</small></q-item-section
                ></q-item
              ><q-item clickable v-close-popup @click="apiAccessOpen = true"
                ><q-item-section>API &amp; MCP access</q-item-section></q-item
              ><q-item
                clickable
                v-close-popup
                @click="
                  run(async () => {
                    await w.flush();
                    await signOut(auth);
                  })
                "
                ><q-item-section>Sign out</q-item-section></q-item
              ></q-list
            ></q-menu
          ></q-btn
        >
      </div>
    </header>
    <q-banner v-if="w.error" class="error-banner" inline-actions
      >{{ w.error
      }}<template #action
        ><q-btn flat label="Retry saves" @click="run(() => w.flush())" /><q-btn
          flat
          label="Dismiss"
          @click="w.error = ''" /></template
    ></q-banner>
    <div v-if="!w.ready" class="onboarding">
      <q-spinner color="primary" size="36px" />
      <p>Connecting to your workspace…</p>
    </div>
    <main v-else-if="!w.user" class="onboarding">
      <section class="card login-card">
        <span class="brand-mark large"><i></i><i></i><i></i></span>
        <h1>Your event, in order.</h1>
        <p>Plan the running order. Give every person the pack they need.</p>
        <q-banner v-if="!configured" class="bg-orange-1"
          >Add Firebase settings to app/.env.local before signing in.</q-banner
        ><q-btn
          color="primary"
          no-caps
          label="Continue with Google"
          :loading="busy"
          @click="run(() => signInWithPopup(auth, new GoogleAuthProvider()))"
        />
        <div class="divider-label">or use your email</div>
        <q-input
          v-model="email"
          outlined
          dense
          type="email"
          label="Email address"
          @keyup.enter="run(emailLink)"
        /><q-btn
          outline
          no-caps
          label="Email me a sign-in link"
          :loading="busy"
          @click="run(emailLink)"
        /><q-btn
          v-if="w.emulator"
          flat
          no-caps
          label="Sign in to seeded demo"
          @click="
            run(() => signInWithEmailAndPassword(auth, 'producer@example.com', 'rundown-demo'))
          "
        />
      </section>
    </main>
    <main v-else-if="!w.tenant" class="onboarding">
      <section class="card login-card">
        <h1>Set the stage.</h1>
        <p>Create an organisation to keep your events, people and templates together.</p>
        <q-input
          v-model="orgName"
          outlined
          label="Organisation name"
          @keyup.enter="run(() => w.createTenant(orgName, sample))"
        /><q-checkbox v-model="sample" label="Include the sample event from the handover" /><q-btn
          color="primary"
          no-caps
          label="Create organisation"
          :disable="!orgName.trim()"
          :loading="busy"
          @click="run(() => w.createTenant(orgName, sample))"
        />
      </section>
    </main>
    <router-view v-else />
    <ApiAccess v-if="w.user" v-model="apiAccessOpen" />
  </div>
</template>
