<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../boot/firebase';
import { time } from '../render/domain';
import type { PublicRunsheet, RunsheetLink } from '../types/public-runsheet';

const route = useRoute();
const data = ref<PublicRunsheet | null>(null);
const sessionId = ref(''),
  viewId = ref(''),
  loading = ref(true),
  error = ref('');
let requestId = 0;
const session = computed(() => data.value?.sessions.find((s) => s.id === data.value?.sessionId));
const view = computed(() => data.value?.views.find((v) => v.id === viewId.value));
const sessionDate = computed(() =>
  session.value && data.value
    ? new Intl.DateTimeFormat('en-AU', {
        timeZone: data.value.timeZone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(new Date(session.value.startAt))
    : '',
);
function sessionLabel(s: PublicRunsheet['sessions'][number]) {
  const date = new Intl.DateTimeFormat('en-AU', {
    timeZone: data.value!.timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(s.startAt));
  return `${s.name} · ${date} · ${time(s.startAt, 0, data.value!.timeZone, true)}`;
}
async function load() {
  const current = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const params = Object.fromEntries(
      ['tenantId', 'eventId', route.params.personId ? 'personId' : 'sessionId', 'token'].map(
        (key) => [key, String(route.params[key] ?? '')],
      ),
    ) as unknown as RunsheetLink;
    const result = await httpsCallable<
      Omit<RunsheetLink, 'sessionId'> & { sessionId?: string },
      PublicRunsheet
    >(
      functions,
      'publicRunsheet',
    )({
      ...params,
      ...(sessionId.value ? { sessionId: sessionId.value } : {}),
    });
    if (current !== requestId) return;
    data.value = result.data;
    sessionId.value = result.data.sessionId ?? '';
    if (!result.data.views.some((v) => v.id === viewId.value))
      viewId.value = result.data.views[0]?.id ?? '';
    document.title = `${result.data.person?.name ?? result.data.sessions[0]?.name ?? 'Session runsheet'} · ${result.data.eventName} · Rundown`;
  } catch (e) {
    if (current !== requestId) return;
    error.value =
      (e as { code?: string }).code === 'functions/not-found'
        ? 'This link or session is no longer available. Ask the event organiser for an updated link.'
        : 'The runsheet could not be loaded. Check your connection and try again.';
  } finally {
    if (current === requestId) loading.value = false;
  }
}
watch(
  () => route.path,
  () => {
    data.value = null;
    sessionId.value = '';
    viewId.value = '';
    void load();
  },
  { immediate: true },
);
const robots = document.createElement('meta');
robots.name = 'robots';
robots.content = 'noindex, nofollow';
document.head.append(robots);
const referrer = document.createElement('meta');
referrer.name = 'referrer';
referrer.content = 'no-referrer';
document.head.append(referrer);
onUnmounted(() => {
  requestId++;
  robots.remove();
  referrer.remove();
  document.title = 'Rundown';
});
</script>

<template>
  <div class="public-runsheet">
    <header class="runsheet-topbar">
      <span class="brand"
        ><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>Rundown</span
      >
      <q-btn flat no-caps icon="refresh" label="Refresh" :disable="loading" @click="load" />
    </header>
    <main class="runsheet-content" :aria-busy="loading">
      <template v-if="data">
        <div class="runsheet-intro">
          <p>{{ data.eventName }}</p>
          <h1>{{ data.person?.name ?? session?.name ?? 'Session runsheet' }}</h1>
          <p v-if="data.person?.role" class="runsheet-role">{{ data.person.role }}</p>
        </div>
        <div
          v-if="(data.person && data.sessions.length) || data.views.length > 1"
          class="runsheet-controls"
        >
          <label v-if="data.person && data.sessions.length" for="runsheet-session"
            >Session
            <select id="runsheet-session" v-model="sessionId" :disabled="loading" @change="load">
              <option v-for="s in data.sessions" :key="s.id" :value="s.id">
                {{ sessionLabel(s) }}
              </option>
            </select>
          </label>
          <label v-if="data.views.length > 1" for="runsheet-view"
            >View
            <select id="runsheet-view" v-model="viewId" :disabled="loading">
              <option v-for="v in data.views" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
          </label>
        </div>
      </template>
      <div v-if="loading" class="runsheet-state" role="status">
        <q-spinner color="primary" size="32px" />
        <p>Loading runsheet…</p>
      </div>
      <div v-else-if="error" class="runsheet-state" role="alert">
        <h1>Runsheet unavailable</h1>
        <p>{{ error }}</p>
        <q-btn
          outline
          no-caps
          label="Try again"
          @click="
            sessionId = '';
            load();
          "
        />
      </div>
      <template v-else-if="data">
        <div v-if="!data.sessions.length" class="runsheet-state">
          <h2>No sessions selected</h2>
          <p>The organiser hasn’t added any sessions to your pack yet.</p>
        </div>
        <section v-else-if="session" class="runsheet-session" aria-labelledby="runsheet-title">
          <div class="runsheet-session-heading">
            <h2 id="runsheet-title">
              {{ data.person ? session.name : (view?.name ?? 'Runsheet') }}
            </h2>
            <p>
              {{ sessionDate }} ·
              <span class="mono">{{ time(session.startAt, 0, data.timeZone, true) }}</span>
            </p>
            <p v-if="view && data.person">{{ view.name }}</p>
          </div>
          <div v-if="view" class="runsheet-items" v-html="view.html"></div>
          <p v-else class="runsheet-state">
            The organiser hasn’t added any available templates to your pack yet.
          </p>
        </section>
        <footer class="runsheet-footer">
          Showing saved content. Refresh for the latest changes.
        </footer>
      </template>
    </main>
  </div>
</template>

<style lang="scss">
.public-runsheet {
  min-height: 100dvh;
  font-size: 16px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  ::selection {
    background: #eef3ff;
    color: #16181d;
  }
  .q-btn {
    min-height: 44px;
  }
  .runsheet-topbar {
    background: #fff;
    border-bottom: 1px solid #e2e5ea;
    padding: 8px max(16px, calc((100% - 760px) / 2));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .runsheet-content {
    max-width: 792px;
    margin: 0 auto;
    padding: 28px 16px 40px;
  }
  .runsheet-intro {
    margin-bottom: 24px;
    p {
      color: #3d4350;
    }
    h1 {
      font-size: 28px;
      line-height: 1.25;
      margin: 6px 0;
    }
    .runsheet-role {
      color: #5b6270;
      font-size: 14px;
    }
  }
  .runsheet-controls {
    display: grid;
    gap: 16px;
    margin-bottom: 28px;
  }
  label {
    color: #3d4350;
    font-size: 14px;
    font-weight: 500;
    min-width: 0;
  }
  select {
    display: block;
    width: 100%;
    min-height: 48px;
    margin-top: 6px;
    padding: 10px 12px;
    border: 1px solid #d5d9e0;
    border-radius: 8px;
    background: #fff;
    color: #16181d;
    font-size: 16px;
    &:focus-visible {
      outline: 2px solid #2457d6;
    }
  }
  .runsheet-session-heading {
    margin-bottom: 20px;
    h2 {
      font-size: 22px;
      line-height: 1.3;
    }
    p {
      margin-top: 6px;
      color: #5b6270;
      font-size: 14px;
    }
  }
  .runsheet-state {
    padding: 32px 0;
    p {
      margin: 12px 0 20px;
    }
  }
  .print-card {
    background: #fff;
    border: 1px solid #e2e5ea;
    border-radius: 12px;
    padding: 18px;
    gap: 16px;
    margin-bottom: 16px;
    white-space: normal;
    &.recipient-row {
      background: #eef3ff;
      border-color: #b4c7f2;
    }
    .print-card-heading {
      flex-direction: column;
      gap: 12px;
    }
    h2 {
      font-size: 21px;
      line-height: 1.35;
      white-space: pre-wrap;
    }
    .print-card-meta {
      font-size: 12px;
      text-transform: none;
      letter-spacing: normal;
      color: #5b6270;
    }
    .print-card-timing {
      text-align: left;
      flex-wrap: wrap;
      gap: 16px;
      flex-shrink: 1;
    }
    .print-card-timing small,
    .print-field small {
      font-size: 12px;
      text-transform: none;
      letter-spacing: normal;
    }
    .print-card-timing span {
      font-size: 15px;
    }
    .print-field {
      width: 100%;
      flex: auto;
      font-size: 16px;
      line-height: 1.6;
    }
    .print-field > div {
      white-space: pre-wrap;
    }
    .field-script {
      padding: 0;
      background: transparent;
      font-size: 16px;
    }
  }
  .print-context {
    flex-wrap: wrap;
    gap: 8px 12px;
    font-size: 14px;
    padding: 14px;
    border-color: #d5d9e0;
    white-space: pre-wrap;
    b {
      flex-basis: 60%;
    }
    small {
      text-transform: none;
      font-size: 12px;
    }
    > span:last-child {
      width: 100%;
    }
  }
  .print-gap {
    font-size: 13px;
    margin-bottom: 16px;
  }
  .print-slide {
    width: auto;
    max-width: 100%;
    max-height: none;
    height: auto;
  }
  .runsheet-footer {
    margin-top: 28px;
    font-size: 12px;
    color: #5b6270;
  }
  @media (min-width: 600px) {
    .runsheet-content {
      padding-top: 40px;
    }
    .print-card {
      padding: 24px;
    }
    .print-card .print-card-heading {
      flex-direction: row;
    }
    .print-card .print-card-heading > div:first-child {
      min-width: 0;
    }
    .print-card .print-card-timing {
      justify-content: flex-end;
      text-align: right;
    }
  }
}
</style>
