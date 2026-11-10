<script setup lang="ts">
import { computed, ref } from 'vue';
import { waitForPendingWrites } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../boot/firebase';
import { useWorkspace } from '../stores/workspace';
import { includesSession } from '../render/pack-selection';
import { validPersonEmail } from '../types/person-email';
import type { Person } from '../types';

const emit = defineEmits<{ queued: [count: number] }>();
const w = useWorkspace(),
  busy = ref(false),
  selected = ref<string[]>([]);
const subject = ref(`Your rundowns for ${w.event?.name ?? 'your event'}`.slice(0, 200)),
  message = ref(
    'At the event, you will also be supplied with (or can request) hard copies of these rundowns. If you have any questions, please reply to this email.',
  );
const validSubject = computed(
  () => !!subject.value.trim() && subject.value.length <= 200 && !/[\r\n]/.test(subject.value),
);
let submission: { key: string; requestId: string } | undefined;
function unavailable(p: Person) {
  if (!p.email?.trim()) return 'Add an email address in People.';
  if (!validPersonEmail(p.email)) return 'Enter a valid email address in People.';
  if (
    !p.pack.templates.length ||
    p.pack.templates.some((ref) => !w.templates.some((t) => t.id === ref.templateId)) ||
    !w.sessions.some((s) => includesSession(p.pack, s.id))
  )
    return 'Choose templates and sessions in Export.';
  return '';
}
const eligible = computed(() => w.people.filter((p) => !unavailable(p)));
const recipients = computed(() => eligible.value.filter((p) => selected.value.includes(p.id)));
async function enqueue() {
  if (
    busy.value ||
    !w.canEdit ||
    !recipients.value.length ||
    !validSubject.value ||
    message.value.length > 5000
  )
    return;
  const data = {
    tenantId: w.tenantId,
    eventId: w.eventId,
    recipients: recipients.value.map((p) => ({ personId: p.id, email: p.email!.trim() })),
    subject: subject.value.trim(),
    message: message.value.trim(),
  };
  const key = JSON.stringify(data);
  if (submission?.key !== key) submission = { key, requestId: crypto.randomUUID() };
  busy.value = true;
  try {
    if (!navigator.onLine) throw new Error('Connect to the internet to queue emails.');
    await w.flush();
    await waitForPendingWrites(db);
    if (w.tenantId !== data.tenantId || w.eventId !== data.eventId || !w.canEdit) return;
    const result = await httpsCallable<typeof data & { requestId: string }, { queued: number }>(
      functions,
      'queueEmails',
    )({ ...data, requestId: submission.requestId });
    submission = undefined;
    selected.value = [];
    emit('queued', result.data.queued);
  } catch (error) {
    w.fail(error);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="card email-composer">
    <div class="compose-heading">
      <h2>Compose email</h2>
      <p class="muted">
        Each person receives their own PDF and existing digital runsheet link. Blank print-padding
        pages are removed from the attachment.
      </p>
    </div>
    <div class="compose-fields">
      <q-input
        v-model="subject"
        label="Subject"
        outlined
        dense
        maxlength="200"
        :disable="busy || !w.canEdit"
        :rules="[() => validSubject || 'Enter a subject of up to 200 characters on one line']"
        lazy-rules
        hide-bottom-space
      />
      <q-input
        v-model="message"
        class="q-mt-md"
        label="Message (optional)"
        type="textarea"
        outlined
        dense
        rows="4"
        maxlength="5000"
        :disable="busy || !w.canEdit"
        hint="Included in every selected person's email."
      />
    </div>
    <div class="compose-recipients">
      <h3>Recipients</h3>
      <p class="muted">
        Manage email addresses in <router-link to="/people">People</router-link> and pack contents
        in <router-link to="/export">Export</router-link>.
      </p>
      <q-checkbox
        label="Select all eligible people"
        :model-value="
          !recipients.length ? false : recipients.length === eligible.length ? true : null
        "
        :disable="busy || !eligible.length || !w.canEdit"
        @update:model-value="
          selected = recipients.length === eligible.length ? [] : eligible.map((p) => p.id)
        "
      />
      <q-list separator aria-label="Email recipients">
        <q-item v-for="p in w.people" :key="p.id">
          <q-item-section side
            ><q-checkbox
              v-model="selected"
              :val="p.id"
              :aria-label="'Email ' + p.name"
              :disable="busy || !!unavailable(p) || !w.canEdit"
          /></q-item-section>
          <q-item-section>
            <q-item-label>{{ p.name }}</q-item-label>
            <q-item-label caption class="email-address">{{
              p.email || 'No email address'
            }}</q-item-label>
            <q-item-label v-if="unavailable(p)" caption>{{ unavailable(p) }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
      <p v-if="!w.people.length" class="empty-state">
        Add people and their email addresses in People to get started.
      </p>
    </div>
    <div class="compose-actions">
      <div>
        <p class="muted">
          Sending continues in the background. You can leave this page once queued.
        </p>
        <p v-if="recipients.length > 100" class="text-negative" role="alert">
          Queue up to 100 people at a time. Deselect some recipients to continue.
        </p>
      </div>
      <q-btn
        unelevated
        color="primary"
        no-caps
        icon="outgoing_mail"
        :label="'Queue emails (' + recipients.length + ')'"
        :loading="busy"
        :disable="
          !w.canEdit ||
          !recipients.length ||
          recipients.length > 100 ||
          !validSubject ||
          message.length > 5000
        "
        @click="enqueue"
      />
    </div>
  </section>
</template>
<style scoped lang="scss">
.email-composer {
  max-width: 850px;
  padding: 0;
}
.compose-heading,
.compose-fields,
.compose-recipients,
.compose-actions {
  padding: 20px 24px;
}
.compose-heading {
  padding-bottom: 0;
}
.compose-heading p,
.compose-actions p {
  line-height: 1.6;
  margin-bottom: 0;
}
.compose-recipients {
  border-block: 1px solid #e2e5ea;
}
.compose-recipients h3 {
  margin-top: 0;
}
.email-address {
  overflow-wrap: anywhere;
}
.compose-actions {
  display: flex;
  gap: 24px;
  justify-content: space-between;
  align-items: center;
}
.compose-actions .q-btn {
  flex-shrink: 0;
}
@media (max-width: 600px) {
  .compose-heading,
  .compose-fields,
  .compose-recipients,
  .compose-actions {
    padding-inline: 16px;
  }
  .compose-actions {
    align-items: stretch;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
