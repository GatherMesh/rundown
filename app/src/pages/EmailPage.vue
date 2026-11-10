<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Notify } from 'quasar';
import { db, functions } from '../boot/firebase';
import { useWorkspace } from '../stores/workspace';
import EventPicker from '../components/EventPicker.vue';
import EmailComposer from '../components/EmailComposer.vue';
import type { EmailJob } from '../types/email-job';

const w = useWorkspace(),
  tab = ref('compose'),
  jobs = ref<EmailJob[]>([]),
  loading = ref(true),
  loadError = ref(''),
  retrying = ref('');
const scopeKey = computed(() => JSON.stringify([w.tenantId, w.eventId]));
const labels = {
  queued: 'Queued',
  preparing: 'Preparing PDF',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
};
watch(
  scopeKey,
  (_, __, cleanup) => {
    jobs.value = [];
    loading.value = true;
    loadError.value = '';
    tab.value = 'compose';
    if (!w.tenantId || !w.eventId) {
      loading.value = false;
      return;
    }
    cleanup(
      onSnapshot(
        query(
          collection(db, `${w.eventPath()}/emailJobs`),
          orderBy('createdAt', 'desc'),
          limit(100),
        ),
        (snapshot) => {
          jobs.value = snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as EmailJob);
          loading.value = false;
        },
        (error) => {
          loading.value = false;
          loadError.value = error.message;
        },
      ),
    );
  },
  { immediate: true },
);
function queued(count: number) {
  tab.value = 'queue';
  Notify.create({
    type: 'positive',
    message: `${count} email${count === 1 ? '' : 's'} queued. Sending continues in the background.`,
  });
}
function date(job: EmailJob) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: w.event?.timeZone ?? 'Australia/Brisbane',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(job.createdAt.toDate());
}
async function retry(job: EmailJob) {
  if (retrying.value || !w.canEdit) return;
  retrying.value = job.id;
  try {
    await httpsCallable(
      functions,
      'retryEmailJob',
    )({ tenantId: w.tenantId, eventId: w.eventId, jobId: job.id, attempt: job.attempt });
  } catch (error) {
    w.fail(error);
  } finally {
    retrying.value = '';
  }
}
</script>
<template>
  <div class="workspace reference-workspace">
    <aside class="sidebar">
      <EventPicker />
      <p class="muted reference-description">
        Send each person their session pack and digital runsheet link. Follow progress in the queue.
      </p>
    </aside>
    <main class="workspace-main email-main">
      <div class="section-heading">
        <div>
          <h1>Email</h1>
          <p class="muted">{{ w.event?.name }}</p>
        </div>
      </div>
      <q-tabs
        v-model="tab"
        align="left"
        no-caps
        active-color="primary"
        indicator-color="primary"
        class="email-tabs"
      >
        <q-tab name="compose" label="Compose" /><q-tab name="queue" label="Queue" />
      </q-tabs>
      <EmailComposer v-if="w.event" v-show="tab === 'compose'" :key="scopeKey" @queued="queued" />
      <section v-else-if="tab === 'compose'" class="card empty-state">
        Select or create an event to email its rundowns.
      </section>
      <section v-show="tab === 'queue'" class="card email-queue">
        <div class="queue-heading">
          <h2>Email queue</h2>
          <p class="muted">Latest 100 emails for this event. Progress updates automatically.</p>
        </div>
        <div v-if="loading" class="empty-state" role="status">
          <q-spinner color="primary" /> Loading queue…
        </div>
        <p v-else-if="loadError" class="empty-state text-negative" role="alert">
          Could not load the queue. {{ loadError }}
        </p>
        <div v-else-if="!jobs.length" class="empty-state">
          <h3>No emails queued yet</h3>
          <p>Choose your recipients and write a message in Compose.</p>
          <q-btn flat color="primary" no-caps label="Compose email" @click="tab = 'compose'" />
        </div>
        <div v-else class="table-scroll">
          <table class="queue-table">
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Queued</th>
                <th><span class="q-sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in jobs" :key="job.id" :data-job-id="job.id">
                <td>
                  <strong>{{ job.recipientName }}</strong>
                  <div class="muted queue-address">{{ job.email }}</div>
                </td>
                <td class="queue-subject">{{ job.subject }}</td>
                <td>
                  <q-chip
                    dense
                    :color="
                      job.status === 'sent'
                        ? 'green-1'
                        : job.status === 'failed'
                          ? 'red-1'
                          : 'blue-1'
                    "
                    :text-color="
                      job.status === 'sent'
                        ? 'green-10'
                        : job.status === 'failed'
                          ? 'negative'
                          : 'primary'
                    "
                    >{{ labels[job.status] }}</q-chip
                  >
                  <p v-if="job.error" class="queue-error text-negative">{{ job.error }}</p>
                </td>
                <td class="queue-date">
                  <span class="queue-date-label">Queued </span>{{ date(job) }}
                </td>
                <td>
                  <q-btn
                    v-if="job.status === 'failed' && job.retryable !== false"
                    outline
                    no-caps
                    color="primary"
                    label="Retry"
                    :aria-label="'Retry email to ' + job.recipientName"
                    :loading="retrying === job.id"
                    :disable="!w.canEdit || !!retrying"
                    @click="retry(job)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</template>
<style scoped lang="scss">
.email-tabs {
  margin: 0 0 20px;
  border-bottom: 1px solid #e2e5ea;
}
.email-queue {
  padding: 0;
}
.queue-heading {
  padding: 20px 24px 8px;
}
.queue-address,
.queue-subject {
  overflow-wrap: anywhere;
}
.queue-subject {
  min-width: 160px;
  max-width: 300px;
}
.queue-error {
  margin: 6px 0 0;
  max-width: 280px;
  font-size: 12px;
  line-height: 1.5;
}
.queue-date {
  min-width: 150px;
}
.queue-table td {
  vertical-align: top;
}
.queue-table td:first-child {
  min-width: 190px;
}
.queue-table td:nth-child(3) {
  min-width: 220px;
}
.queue-date-label {
  display: none;
}
@media (max-width: 1000px) {
  .queue-table,
  .queue-table tbody {
    display: block;
  }
  .queue-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .queue-table tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    padding: 16px 24px;
    border-bottom: 1px solid #eef0f3;
  }
  .queue-table td {
    padding: 0;
    border: 0;
  }
  .queue-table td,
  .queue-table td:first-child,
  .queue-table td:nth-child(3) {
    min-width: 0;
  }
  .queue-table td:first-child {
    grid-area: 1 / 1 / 2 / 3;
  }
  .queue-table td:nth-child(2) {
    grid-area: 2 / 1 / 3 / 3;
    max-width: none;
  }
  .queue-table td:nth-child(3) {
    grid-area: 3 / 1;
  }
  .queue-table td:nth-child(4) {
    grid-area: 4 / 1 / 5 / 3;
    color: #5b6270;
  }
  .queue-table td:nth-child(5) {
    grid-area: 3 / 2;
  }
  .queue-date-label {
    display: inline;
  }
}
</style>
