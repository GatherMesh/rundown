<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { waitForPendingWrites } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../boot/firebase';
import { useWorkspace } from '../stores/workspace';
import { includesSession } from '../render/pack-selection';
import { validPersonEmail } from '../types/person-email';
import type { Person } from '../types';

const w = useWorkspace(),
  dialog = ref(false),
  busy = ref(false);
const selected = ref<string[]>([]),
  results = ref<Record<string, string>>({}),
  progress = ref(''),
  subject = ref(''),
  message = ref('');
const validSubject = computed(
  () => !!subject.value.trim() && subject.value.length <= 200 && !/[\r\n]/.test(subject.value),
);
const retries = new Map<
  string,
  { email: string; jobId: string; subject: string; message: string }
>();
let active = true;
onBeforeUnmount(() => {
  active = false;
});
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
function open(personId?: string) {
  results.value = {};
  selected.value = personId && eligible.value.some((p) => p.id === personId) ? [personId] : [];
  progress.value = '';
  if (!subject.value)
    subject.value = `Your rundowns for ${w.event?.name ?? 'your event'}`.slice(0, 200);
  dialog.value = true;
}
defineExpose({ open });
const render = httpsCallable(functions, 'renderPack', { timeout: 300000 });
const send = httpsCallable(functions, 'emailPack');
async function sendSelected() {
  if (
    busy.value ||
    !w.canEdit ||
    !recipients.value.length ||
    !validSubject.value ||
    message.value.length > 5000
  )
    return;
  const content = { subject: subject.value.trim(), message: message.value.trim() };
  const batch = recipients.value.map((p) => ({
    personId: p.id,
    name: p.name,
    email: p.email!.trim(),
  }));
  const scope = { tenantId: w.tenantId, eventId: w.eventId };
  busy.value = true;
  try {
    if (!navigator.onLine) throw new Error('Connect to the internet to email session packs.');
    await w.flush();
    await waitForPendingWrites(db);
    for (const [i, recipient] of batch.entries()) {
      if (!active || !w.canEdit || scope.tenantId !== w.tenantId || scope.eventId !== w.eventId)
        break;
      const { personId, name, email } = recipient;
      progress.value = `Sending ${i + 1} of ${batch.length} · ${name}`;
      try {
        let saved = retries.get(personId);
        if (
          !saved ||
          saved.email !== email ||
          saved.subject !== content.subject ||
          saved.message !== content.message
        ) {
          const jobId = crypto.randomUUID();
          await render({ ...scope, personId, jobId });
          saved = { jobId, email, ...content };
          retries.set(personId, saved);
        }
        if (!active || !w.canEdit || scope.tenantId !== w.tenantId || scope.eventId !== w.eventId)
          break;
        await send({ ...scope, personId, ...saved });
        retries.delete(personId);
        selected.value = selected.value.filter((id) => id !== personId);
        results.value[personId] = 'Sent';
      } catch (error) {
        if ((error as { details?: { newPack?: boolean } }).details?.newPack)
          retries.delete(personId);
        results.value[personId] =
          error instanceof Error ? error.message : 'Sending could not be confirmed.';
      }
    }
  } catch (error) {
    w.fail(error);
  } finally {
    busy.value = false;
    progress.value = '';
  }
}
</script>
<template>
  <q-btn
    outline
    no-caps
    color="primary"
    icon="mail_outline"
    label="Email packs"
    :disable="!w.canEdit || !w.people.length"
    @click="open()"
  />
  <q-dialog v-model="dialog" :persistent="busy" aria-labelledby="email-packs-title">
    <q-card class="dialog-card email-packs">
      <q-card-section>
        <h2 id="email-packs-title">Email rundowns</h2>
        <p class="muted">{{ w.event?.name }}</p>
        <div class="email-includes">
          <q-icon name="attach_file" size="22px" color="primary" aria-hidden="true" />
          <div>
            <strong>A personal PDF and a digital link</strong>
            <p>
              Each person receives their selected sessions and templates in one attached PDF, plus a
              link to their latest rundowns. No login needed.
            </p>
          </div>
        </div>
        <q-input
          v-model="subject"
          class="q-mt-md"
          label="Subject"
          outlined
          dense
          maxlength="200"
          :disable="busy"
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
          rows="3"
          maxlength="5000"
          :disable="busy"
          hint="Included in every selected person's email."
        />
      </q-card-section>
      <q-card-section class="email-recipients">
        <q-checkbox
          label="Select all eligible people"
          :model-value="
            !recipients.length ? false : recipients.length === eligible.length ? true : null
          "
          :disable="busy || !eligible.length"
          @update:model-value="
            selected = recipients.length === eligible.length ? [] : eligible.map((p) => p.id)
          "
        />
        <q-list separator aria-label="Email recipients">
          <q-item v-for="p in w.people" :key="p.id">
            <q-item-section side>
              <q-checkbox
                v-model="selected"
                :val="p.id"
                :aria-label="'Email ' + p.name"
                :disable="busy || !!unavailable(p)"
              />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ p.name }}</q-item-label>
              <q-item-label caption class="email-address">{{
                p.email || 'No email address'
              }}</q-item-label>
              <q-item-label v-if="unavailable(p)" caption>{{ unavailable(p) }}</q-item-label>
              <q-item-label
                v-if="results[p.id]"
                caption
                role="status"
                :class="results[p.id] === 'Sent' ? 'text-positive' : 'text-negative'"
                >{{ results[p.id] }}</q-item-label
              >
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>
      <q-card-section v-if="progress" class="email-progress" role="status">{{
        progress
      }}</q-card-section>
      <q-card-actions align="right">
        <q-btn flat no-caps label="Close" :disable="busy" v-close-popup />
        <q-btn
          color="primary"
          no-caps
          icon="send"
          :label="'Send emails (' + recipients.length + ')'"
          :loading="busy"
          :disable="!w.canEdit || !recipients.length || !validSubject || message.length > 5000"
          @click="sendSelected"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>
<style scoped lang="scss">
.email-packs {
  display: flex;
  flex-direction: column;
  max-height: 90vh;
}
.email-includes {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 20px;
}
.email-includes p {
  margin: 4px 0 0;
  color: #5b6270;
  line-height: 1.6;
}
.email-recipients {
  overflow-y: auto;
  border-block: 1px solid #e2e5ea;
  padding-top: 8px;
}
.email-address {
  overflow-wrap: anywhere;
}
.email-progress {
  color: #2457d6;
}
</style>
