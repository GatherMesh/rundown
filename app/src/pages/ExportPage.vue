<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { httpsCallable } from 'firebase/functions';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import { getBlob, ref as storageRef } from 'firebase/storage';
import { Notify } from 'quasar';
import { functions, db, storage } from '../boot/firebase';
import { useWorkspace } from '../stores/workspace';
import { payload } from '../render/payload';
import { renderDocument } from '../render/renderer';
import { computeItems, planPack } from '../render/domain';
import { includesSession } from '../render/pack-selection';
import type { Item, PackSettings, Person, Session } from '../types';
const w = useWorkspace(),
  selected = ref('margaret'),
  counts = ref<Record<string, Record<string, Record<string, number>>>>({}),
  sessionItems = ref<Record<string, Item[]>>({}),
  previewSessionId = ref(''),
  busy = ref(false),
  calculating = ref(false),
  progress = ref(''),
  warning = ref(''),
  drag = ref(-1),
  addTemplateId = ref(''),
  pdfUrl = ref(''),
  pdfOpen = ref(false);
const person = computed(() => w.people.find((p) => p.id === selected.value) ?? w.people[0]);
const duplicateOpen = ref(false),
  duplicateSourceId = ref(''),
  duplicateTargetId = ref('');
const duplicateSource = computed(() => w.people.find((p) => p.id === duplicateSourceId.value));
const duplicateTargets = computed(() => w.people.filter((p) => p.id !== duplicateSourceId.value));
watch(
  () => [w.tenantId, w.eventId],
  () => {
    duplicateOpen.value = false;
  },
);
function openDuplicate() {
  if (!person.value) return;
  duplicateSourceId.value = person.value.id;
  duplicateTargetId.value = '';
  duplicateOpen.value = true;
}
function duplicateConfig() {
  try {
    w.duplicatePack(duplicateSourceId.value, duplicateTargetId.value);
    selected.value = duplicateTargetId.value;
    duplicateOpen.value = false;
  } catch (e) {
    w.fail(e);
  }
}
const sidesOptions = [
  { label: 'Single', value: 'single' },
  { label: 'Double · long edge', value: 'duplexLong' },
  { label: 'Double · short edge', value: 'duplexShort' },
];
const scalingOptions = [
  { label: 'Fit to A4', value: 'fit', icon: 'fit_screen' },
  { label: 'Actual size', value: 'actual', icon: 'crop_original' },
  { label: '2 per sheet', value: '2up', icon: 'view_column' },
  { label: '4 per sheet', value: '4up', icon: 'grid_view' },
];
const previewSession = computed(
  () => w.sessions.find((s) => s.id === previewSessionId.value) ?? w.sessions[0],
);
function enabledSessions(p: Person) {
  return w.sessions.filter((s) => includesSession(p.pack, s.id));
}
const sessionItemsReady = computed(() =>
  w.sessions.every((s) => sessionItems.value[s.id] !== undefined),
);
function enableParticipatingSessions() {
  const p = person.value;
  if (!p || !w.canEdit || busy.value || !sessionItemsReady.value) return;
  const sessionIds = w.sessions
    .filter((s) => sessionItems.value[s.id].some((item) => item.personIds.includes(p.id)))
    .map((s) => s.id);
  if (sessionIds.length > 100) {
    Notify.create({ type: 'warning', message: 'Choose up to 100 sessions per person.' });
    return;
  }
  patch({ sessionIds });
}
function toggleSession(sessionId: string, enabled: boolean) {
  if (!person.value) return;
  const ids = new Set(enabledSessions(person.value).map((s) => s.id));
  if (enabled) ids.add(sessionId);
  else ids.delete(sessionId);
  if (ids.size > 100) {
    Notify.create({ type: 'warning', message: 'Choose up to 100 sessions per person.' });
    return;
  }
  patch({ sessionIds: [...ids] });
}
function sessionDate(s: Session) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: w.event?.timeZone ?? 'Australia/Brisbane',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(s.startAt.toDate());
}
function plan(p: Person, sessionId = previewSession.value?.id) {
  if (!sessionId || !counts.value[sessionId]?.[p.id]) return null;
  try {
    return planPack(p.pack, counts.value[sessionId][p.id]);
  } catch {
    return null;
  }
}
function personTotals(p: Person) {
  let pages = 0,
    sheets = 0;
  for (const session of enabledSessions(p)) {
    const result = plan(p, session.id);
    if (!result) return null;
    pages += result.pages;
    sheets += result.sheets;
  }
  return { pages, sheets };
}
const enabledPeople = computed(() =>
  w.people.filter((p) => p.pack.enabled && enabledSessions(p).length),
);
const totalSheets = computed(() => {
  let sheets = 0;
  for (const p of enabledPeople.value) {
    const total = personTotals(p);
    if (!total) return '…';
    sheets += total.sheets;
  }
  return sheets;
});
const sheetLayout = computed(() => {
  const p = person.value;
  if (!p) return [];
  const sides = plan(p)?.sides ?? [],
    perSheet = p.pack.sides === 'single' ? 1 : 2;
  return Array.from({ length: Math.ceil(sides.length / perSheet) }, (_, index) =>
    sides.slice(index * perSheet, (index + 1) * perSheet),
  );
});
function patch(part: Partial<PackSettings>, p = person.value) {
  if (p) w.patchPerson(p.id, { pack: { ...p.pack, ...part } });
}
function copies(index: number, delta: number) {
  if (!person.value) return;
  const templates = person.value.pack.templates.map((t) => ({ ...t }));
  templates[index].copies = Math.max(1, Math.min(20, templates[index].copies + delta));
  patch({ templates });
}
function remove(index: number) {
  patch({ templates: person.value!.pack.templates.filter((_, i) => i !== index) });
}
function add() {
  if (!addTemplateId.value || !person.value) return;
  if (!w.templates.some((t) => t.id === addTemplateId.value && !t.archived)) return;
  patch({
    templates: [...person.value.pack.templates, { templateId: addTemplateId.value, copies: 1 }],
  });
  addTemplateId.value = '';
}
function reorder(index: number) {
  if (!person.value) return;
  const refs = [...person.value.pack.templates],
    moved = refs.splice(drag.value, 1)[0];
  refs.splice(index, 0, moved);
  patch({ templates: refs });
}
// Export listens to the event's sessions without changing the session open in the editor.
watch(
  () => [w.tenantId, w.eventId, w.sessions.map((s) => s.id).join(',')],
  (_, __, cleanup) => {
    sessionItems.value = {};
    if (!w.tenantId || !w.eventId) return;
    const stops = w.sessions.map((s) =>
      onSnapshot(
        collection(db, `${w.eventPath()}/sessions/${s.id}/items`),
        (snapshot) => {
          sessionItems.value[s.id] = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as Item);
        },
        w.fail,
      ),
    );
    cleanup(() => stops.forEach((stop) => stop()));
  },
  { immediate: true },
);
let timer: ReturnType<typeof setTimeout>,
  version = 0;
watch(
  () =>
    JSON.stringify([
      sessionItems.value,
      w.categories,
      w.templates,
      w.sessions,
      w.event,
      w.tenant,
      previewSession.value?.id,
      person.value?.id,
      w.people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        sessionIds: p.pack.sessionIds,
        templates: p.pack.templates.map((t) => t.templateId),
      })),
    ]),
  () => {
    const run = ++version;
    clearTimeout(timer);
    calculating.value = true;
    counts.value = {};
    warning.value = '';
    timer = setTimeout(async () => {
      const next: typeof counts.value = {},
        warnings = new Set<string>();
      try {
        for (const session of w.sessions) {
          if (!sessionItems.value[session.id]) continue;
          const orderedItems = computeItems(sessionItems.value[session.id], w.categories, w.people);
          next[session.id] = {};
          for (const p of w.people) {
            if (!includesSession(p.pack, session.id) && p.id !== person.value?.id) continue;
            next[session.id][p.id] = {};
            for (const t of p.pack.templates) {
              if (run !== version) return;
              const template = w.templates.find((v) => v.id === t.templateId);
              if (!template) {
                warnings.add(`${p.name}: a pack references a missing template.`);
                continue;
              }
              const r = await renderDocument(
                payload(
                  {
                    session,
                    orderedItems,
                    tenant: w.tenant,
                    event: w.event,
                  },
                  template,
                  p,
                ),
              );
              next[session.id][p.id][t.templateId] = r.pageCount;
              if (r.warning) warnings.add(`${p.name} · ${session.name}: ${r.warning}`);
            }
          }
        }
        if (run === version) {
          counts.value = next;
          warning.value = [...warnings].join(' · ');
        }
      } catch (e) {
        if (run === version) warning.value = String(e);
      } finally {
        if (run === version) calculating.value = false;
      }
    }, 400);
  },
  { immediate: true },
);
onUnmounted(() => {
  clearTimeout(timer);
  version++;
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
});
async function generate(action: 'download' | 'print' | 'preview', p?: Person, session?: Session) {
  if (busy.value || !w.event || !w.sessions.length) return;
  busy.value = true;
  progress.value = 'Preparing session packs…';
  const jobId = crypto.randomUUID();
  const stop = onSnapshot(
    doc(db, `${w.base()}/exportJobs/${jobId}`),
    (s) => {
      if (s.exists()) progress.value = s.data().message;
    },
    () => {},
  );
  try {
    await w.flush();
    const call = httpsCallable<
      Record<string, string>,
      { path: string; url?: string; warning?: string }
    >(functions, p ? 'renderPack' : 'renderAllPacks', { timeout: 300000 });
    const result = await call({
      tenantId: w.tenantId,
      eventId: w.eventId,
      ...(session ? { sessionId: session.id } : {}),
      jobId,
      ...(p ? { personId: p.id } : {}),
    });
    const blob = await getBlob(storageRef(storage, result.data.path));
    if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
    pdfUrl.value = URL.createObjectURL(blob);
    if (result.data.warning)
      Notify.create({ type: 'warning', message: result.data.warning, timeout: 10000 });
    if (action === 'download') {
      const a = document.createElement('a');
      a.href = pdfUrl.value;
      a.download = `${session?.name ?? w.event.name}-${p?.name ?? 'all-packs'}.pdf`;
      a.click();
    } else if (action === 'preview') {
      pdfOpen.value = true;
    } else {
      Notify.create({
        message:
          p && session
            ? p.pack.sides === 'single'
              ? 'Print single-sided.'
              : `Print two-sided, flip on ${p.pack.sides === 'duplexShort' ? 'short' : 'long'} edge.`
            : 'Print two-sided, flip on long edge.',
        timeout: 12000,
      });
      const frame = document.createElement('iframe');
      frame.className = 'print-job-frame';
      frame.src = pdfUrl.value;
      document.body.append(frame);
      frame.onload = () => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          pdfOpen.value = true;
        }
      };
      setTimeout(() => {
        frame.remove();
      }, 120000);
      pdfOpen.value = true;
    }
  } catch (e) {
    w.fail(e);
  } finally {
    stop();
    busy.value = false;
    progress.value = '';
  }
}
const initials = (p: Person) =>
  p.initials ||
  p.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('');
</script>
<template>
  <div class="export-workspace">
    <main class="workspace-main">
      <div class="section-heading export-heading">
        <div>
          <h1>Session packs</h1>
          <p class="muted">{{ w.event?.name || 'Select an event' }}</p>
        </div>
        <div class="button-row">
          <span class="muted"
            ><strong>{{ enabledPeople.length }}</strong> of {{ w.people.length }} people ·
            <strong>{{ calculating ? '…' : totalSheets }}</strong> sheets</span
          ><q-btn
            outline
            no-caps
            label="Download all (PDF)"
            :loading="busy"
            :disable="!enabledPeople.length"
            @click="generate('download')"
          /><q-btn
            color="primary"
            no-caps
            icon="print"
            label="Print All"
            :loading="busy"
            :disable="!enabledPeople.length"
            @click="generate('print')"
          />
        </div>
      </div>
      <q-banner v-if="warning" class="bg-orange-1">{{ warning }}</q-banner
      ><q-banner v-if="busy" class="bg-blue-1" role="status"
        ><q-spinner class="q-mr-sm" />{{ progress }}</q-banner
      >
      <section class="card export-table-card">
        <div class="table-scroll">
          <table class="export-table">
            <thead>
              <tr>
                <th>Export</th>
                <th>Person</th>
                <th>Templates</th>
                <th>Sessions</th>
                <th>Scaling</th>
                <th>Sheets</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in w.people"
                :key="p.id"
                :class="{ selected: person?.id === p.id, disabled: !p.pack.enabled }"
                tabindex="0"
                @click="selected = p.id"
                @keydown.enter="selected = p.id"
              >
                <td @click.stop>
                  <q-toggle
                    :model-value="p.pack.enabled"
                    :disable="!w.canEdit"
                    :aria-label="'Enable pack for ' + p.name"
                    size="sm"
                    @update:model-value="(v) => patch({ enabled: v }, p)"
                  />
                </td>
                <td>
                  <div class="person-identity">
                    <span class="person-avatar">{{ initials(p) }}</span>
                    <div>
                      <strong>{{ p.name }}</strong
                      ><small>{{ p.role || 'No role' }}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <span v-for="(t, index) in p.pack.templates" :key="index" class="template-tag"
                    >{{
                      w.templates.find((v) => v.id === t.templateId)?.name || 'Missing template'
                    }}
                    ×{{ t.copies }}</span
                  ><span v-if="!p.pack.templates.length" class="muted">No templates selected</span>
                </td>
                <td>{{ enabledSessions(p).length }} of {{ w.sessions.length }}</td>
                <td>{{ scalingOptions.find((v) => v.value === p.pack.scaling)?.label }}</td>
                <td>{{ p.pack.enabled ? (personTotals(p)?.sheets ?? '…') : '—' }}</td>
                <td>
                  <q-btn
                    outline
                    no-caps
                    dense
                    label="Print all"
                    :aria-label="'Print all sessions for ' + p.name"
                    :disable="busy || !enabledSessions(p).length || !p.pack.templates.length"
                    @click.stop="generate('print', p)"
                  />
                </td>
              </tr>
              <tr v-if="!w.people.length">
                <td colspan="7" class="empty-state">
                  Add people to this event before configuring session packs.
                  <router-link to="/people">Open People</router-link>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p class="muted export-note">
        Choose a person to select their sessions. Print All includes every enabled person’s selected
        sessions, grouped by person. Each session pack starts on a new sheet.
      </p>
    </main>
    <aside v-if="person" class="detail-panel pack-panel">
      <div class="person-identity pack-person">
        <span class="person-avatar">{{ initials(person) }}</span>
        <div>
          <h2>{{ person.name }}</h2>
          <small
            >{{ person.role || 'No role' }} · {{ enabledSessions(person).length }} sessions
            selected</small
          >
        </div>
      </div>
      <q-btn
        outline
        no-caps
        icon="content_copy"
        label="Duplicate config"
        class="full-width q-mb-md"
        :disable="!w.canEdit || busy || w.people.length < 2"
        @click="openDuplicate"
      />
      <section class="pack-sessions">
        <h3>Sessions for {{ person.name }}</h3>
        <p class="muted">Tick the sessions they receive sheets for.</p>
        <q-btn
          outline
          no-caps
          label="Enable All Participating Sessions"
          class="full-width q-mb-sm"
          :disable="!w.canEdit || busy || !w.sessions.length || !sessionItemsReady"
          @click="enableParticipatingSessions"
        />
        <div v-for="session in w.sessions" :key="session.id" class="pack-session-row">
          <q-checkbox
            :model-value="includesSession(person.pack, session.id)"
            :disable="!w.canEdit || busy"
            :aria-label="'Include ' + session.name + ' for ' + person.name"
            @update:model-value="(v) => toggleSession(session.id, v)"
          />
          <div class="pack-session-name">
            <strong>{{ session.name }}</strong>
            <small>{{ sessionDate(session) }}</small>
            <small>{{ plan(person, session.id)?.sheets ?? '…' }} sheets</small>
          </div>
          <div class="pack-session-actions">
            <q-btn
              flat
              dense
              no-caps
              label="Preview"
              :disable="
                busy || !includesSession(person.pack, session.id) || !person.pack.templates.length
              "
              :aria-label="'Preview ' + session.name + ' for ' + person.name"
              @click="generate('preview', person, session)"
            />
            <q-btn
              outline
              dense
              no-caps
              icon="print"
              label="Print"
              :disable="
                busy || !includesSession(person.pack, session.id) || !person.pack.templates.length
              "
              :aria-label="'Print ' + session.name + ' for ' + person.name"
              @click="generate('print', person, session)"
            />
          </div>
        </div>
        <p v-if="!w.sessions.length" class="muted">Add sessions to this event to print sheets.</p>
        <p v-else-if="!enabledSessions(person).length" class="muted">No sessions selected.</p>
        <q-btn
          color="primary"
          no-caps
          icon="print"
          label="Print all for person"
          class="full-width q-mt-sm"
          :loading="busy"
          :disable="!enabledSessions(person).length || !person.pack.templates.length"
          @click="generate('print', person)"
        />
      </section>
      <fieldset :disabled="!w.canEdit" class="form-stack">
        <section>
          <label class="eyebrow">Templates in this pack</label>
          <p class="muted">These templates apply to every selected session.</p>
          <div
            v-for="(r, index) in person.pack.templates"
            :key="index"
            class="pack-template"
            @dragover.prevent
            @drop.prevent="reorder(index)"
          >
            <span class="drag-handle" draggable="true" @dragstart="drag = index">⠿</span>
            <div class="pack-template-name">
              <strong>{{
                w.templates.find((t) => t.id === r.templateId)?.name || 'Missing template'
              }}</strong
              ><small>{{ w.templates.find((t) => t.id === r.templateId)?.orientation }}</small>
            </div>
            <div class="copies-control">
              <button
                :aria-label="'Fewer copies of template ' + (index + 1)"
                @click="copies(index, -1)"
              >
                −</button
              ><span>×{{ r.copies }}</span
              ><button
                :aria-label="'More copies of template ' + (index + 1)"
                @click="copies(index, 1)"
              >
                +
              </button>
            </div>
            <q-btn
              flat
              round
              dense
              size="sm"
              icon="close"
              aria-label="Remove template from pack"
              @click="remove(index)"
            />
          </div>
          <div class="button-row">
            <q-select
              v-model="addTemplateId"
              :options="
                w.templates.filter(
                  (t) => !t.archived && !person!.pack.templates.some((r) => r.templateId === t.id),
                )
              "
              option-label="name"
              option-value="id"
              emit-value
              map-options
              outlined
              dense
              label="Add template"
            /><q-btn
              outline
              dense
              icon="add"
              aria-label="Add selected template"
              :disable="!addTemplateId"
              @click="add"
            />
          </div>
        </section>
        <section>
          <label class="eyebrow">Sides</label
          ><q-btn-toggle
            :model-value="person.pack.sides"
            :options="sidesOptions"
            spread
            no-caps
            unelevated
            color="grey-2"
            text-color="grey-8"
            toggle-color="white"
            toggle-text-color="dark"
            @update:model-value="(v) => patch({ sides: v })"
          />
        </section>
        <section>
          <label class="eyebrow">Scaling</label>
          <div class="scaling-options">
            <button
              v-for="s in scalingOptions"
              :key="s.value"
              class="style-option"
              :class="{ selected: person.pack.scaling === s.value }"
              @click="patch({ scaling: s.value as PackSettings['scaling'] })"
            >
              <q-icon :name="s.icon" size="28px" /><strong>{{ s.label }}</strong>
            </button>
          </div>
        </section>
        <section>
          <label class="eyebrow">Options</label>
          <div class="scope-options">
            <q-checkbox
              :model-value="person.pack.collate"
              label="Collate copies"
              @update:model-value="(v) => patch({ collate: v })"
            /><q-checkbox
              :model-value="person.pack.newSheetPerTemplate"
              label="Start each template on a new sheet"
              @update:model-value="(v) => patch({ newSheetPerTemplate: v })"
            /><q-checkbox
              :model-value="person.pack.coverSheet"
              label="Add a cover sheet with name"
              @update:model-value="(v) => patch({ coverSheet: v })"
            />
          </div>
        </section>
      </fieldset>
      <section v-if="w.sessions.length" class="pack-sheet-layout">
        <h3>Sheet layout</h3>
        <q-select
          :model-value="previewSession?.id"
          :options="w.sessions"
          option-label="name"
          option-value="id"
          emit-value
          map-options
          outlined
          dense
          label="Preview sheet layout for session"
          @update:model-value="(v) => (previewSessionId = v)"
        />
        <p class="muted">
          {{ plan(person)?.pages ?? '…' }} pages · {{ plan(person)?.sheets ?? '…' }} sheets
        </p>
        <p v-if="person.pack.sides !== 'single'" class="muted">
          Each pair prints on one sheet.
          <template v-if="['fit', 'actual'].includes(person.pack.scaling)">
            If the back has a different orientation, it rotates 90° to match the front’s paper
            orientation.
          </template>
        </p>
        <ol class="pack-sheet-list">
          <li v-for="(sheet, sheetIndex) in sheetLayout" :key="sheetIndex">
            <strong>Sheet {{ sheetIndex + 1 }}</strong>
            <div v-for="(side, sideIndex) in sheet" :key="sideIndex" class="pack-sheet-side">
              <b>{{ sideIndex === 0 ? 'Front' : 'Back' }}</b>
              <div>
                <span v-if="side.kind === 'blank'" class="muted">Blank</span>
                <span v-else-if="side.kind === 'cover'">Cover sheet</span>
                <template v-else>
                  <div v-for="(cell, cellIndex) in side.cells" :key="cellIndex">
                    {{
                      w.templates.find((t) => t.id === cell.templateId)?.name || 'Missing template'
                    }}
                    · page {{ cell.page }} · copy {{ cell.copy }}
                  </div>
                </template>
              </div>
            </div>
          </li>
        </ol>
      </section>
      <div class="pack-summary">
        <div>
          <span>Pages across selected sessions</span
          ><strong>{{ personTotals(person)?.pages ?? '…' }}</strong>
        </div>
        <div>
          <span>Sheets ({{ person.pack.sides === 'single' ? 'single' : 'double' }}-sided)</span
          ><strong>{{ personTotals(person)?.sheets ?? '…' }}</strong>
        </div>
        <div class="button-row">
          <q-btn
            outline
            no-caps
            label="Preview all (PDF)"
            :loading="busy"
            :disable="!enabledSessions(person).length || !person.pack.templates.length"
            @click="generate('preview', person)"
          /><q-btn
            color="primary"
            no-caps
            label="Print all for person"
            :loading="busy"
            :disable="!enabledSessions(person).length || !person.pack.templates.length"
            @click="generate('print', person)"
          />
        </div>
      </div>
    </aside>
  </div>
  <q-dialog v-model="duplicateOpen">
    <q-card class="dialog-card">
      <q-card-section>
        <h2>Duplicate export config</h2>
        <p>Copy {{ duplicateSource?.name }}’s configuration to another person in this event.</p>
        <q-select
          v-model="duplicateTargetId"
          :options="duplicateTargets"
          option-label="name"
          option-value="id"
          emit-value
          map-options
          outlined
          dense
          label="Copy to person"
        />
        <p class="muted q-mt-md">
          This replaces their selected sessions, templates, copy counts, print settings and Print
          All toggle. Their name and item assignments stay the same.
        </p>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat no-caps label="Cancel" v-close-popup />
        <q-btn
          color="primary"
          no-caps
          label="Replace config"
          :disable="
            !w.canEdit ||
            busy ||
            !duplicateSource ||
            !duplicateTargets.some((p) => p.id === duplicateTargetId)
          "
          @click="duplicateConfig"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
  <q-dialog v-model="pdfOpen" maximized
    ><q-card class="pdf-dialog"
      ><q-card-section class="section-heading"
        ><h2>Session pack PDF</h2>
        <div class="button-row">
          <a :href="pdfUrl" target="_blank" rel="noopener">Open PDF in a new tab</a
          ><q-btn
            flat
            round
            icon="close"
            v-close-popup
            aria-label="Close PDF"
          /></div></q-card-section
      ><iframe :src="pdfUrl" title="Session pack PDF preview" /></q-card
  ></q-dialog>
</template>
