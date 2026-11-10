<script setup lang="ts">
import { ref } from 'vue';
import { Dialog } from 'quasar';
import { useWorkspace } from '../stores/workspace';
import EmailPacks from '../components/EmailPacks.vue';
import { validPersonEmail } from '../types/person-email';
import EventPicker from '../components/EventPicker.vue';
const props = defineProps<{ kind: string }>(),
  w = useWorkspace(),
  drag = ref(''),
  adding = ref(false),
  saving = ref(false),
  newName = ref(''),
  newEmail = ref(''),
  emailPacks = ref<InstanceType<typeof EmailPacks>>();
function add() {
  if (props.kind === 'people') {
    newName.value = '';
    newEmail.value = '';
    adding.value = true;
    return;
  }
  Dialog.create({
    title: 'Add category',
    prompt: { model: '', label: 'Name', isValid: (v) => v.trim().length > 0 },
    cancel: true,
  }).onOk((name: string) => void w.addCategory(name).catch(w.fail));
}
async function createPerson() {
  if (
    saving.value ||
    !w.canEdit ||
    !newName.value.trim() ||
    (newEmail.value.trim() && !validPersonEmail(newEmail.value))
  )
    return;
  saving.value = true;
  try {
    await w.addPerson(newName.value, '', newEmail.value.trim());
    adding.value = false;
  } catch (error) {
    w.fail(error);
  } finally {
    saving.value = false;
  }
}
function removePerson(id: string) {
  Dialog.create({
    title: 'Delete person?',
    message: 'Their pack settings will also be deleted.',
    options: {
      type: 'checkbox',
      model: [],
      items: [{ label: 'Remove from all event items', value: 'remove' }],
    },
    cancel: true,
    ok: { label: 'Delete', color: 'negative' },
  }).onOk((options: string[]) => void w.removePerson(id, options.includes('remove')).catch(w.fail));
}
function reorder(id: string) {
  const list = w.categories.filter((c) => c.id !== drag.value),
    index = list.findIndex((c) => c.id === id),
    moved = w.categories.find((c) => c.id === drag.value);
  if (!moved) return;
  list.splice(index, 0, moved);
  list.forEach((c, order) => w.patchCategory(c.id, { order }));
}
</script>
<template>
  <div class="workspace reference-workspace">
    <aside class="sidebar">
      <EventPicker />
      <p class="muted reference-description">
        {{
          kind === 'people'
            ? 'People belong to the selected event. Their pack settings apply across its sessions.'
            : 'Categories are shared across every event in your organisation.'
        }}
      </p>
    </aside>
    <main class="workspace-main">
      <div class="section-heading">
        <div>
          <h1>{{ kind === 'people' ? 'People' : 'Categories' }}</h1>
          <p class="muted">{{ kind === 'people' ? w.event?.name : w.tenant?.name }}</p>
        </div>
        <div class="button-row">
          <EmailPacks
            v-if="kind === 'people'"
            ref="emailPacks"
            :key="JSON.stringify([w.tenantId, w.eventId])"
          />
          <q-btn
            color="primary"
            no-caps
            icon="add"
            :label="kind === 'people' ? 'Add person' : 'Add category'"
            :disable="!w.canEdit || (kind === 'people' && !w.event)"
            @click="add"
          />
        </div>
      </div>
      <section class="card">
        <div class="table-scroll">
          <table class="reference-table" v-if="kind === 'people'">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Email</th>
                <th>Initials</th>
                <th>Session items</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in w.people" :key="p.id">
                <td>
                  <q-input
                    :model-value="p.name"
                    outlined
                    dense
                    :readonly="!w.canEdit"
                    @update:model-value="(v) => v && w.patchPerson(p.id, { name: String(v) })"
                  />
                </td>
                <td>
                  <q-input
                    :model-value="p.role || ''"
                    outlined
                    dense
                    :readonly="!w.canEdit"
                    @update:model-value="(v) => w.patchPerson(p.id, { role: String(v ?? '') })"
                  />
                </td>
                <td>
                  <q-input
                    :model-value="p.email || ''"
                    type="email"
                    :aria-label="'Email address for ' + p.name"
                    :error="!!p.email && !validPersonEmail(p.email)"
                    error-message="Enter a valid email address"
                    hide-bottom-space
                    outlined
                    dense
                    :readonly="!w.canEdit"
                    @update:model-value="
                      (v) => w.patchPerson(p.id, { email: String(v ?? '').trim() })
                    "
                  />
                </td>
                <td>
                  <q-input
                    class="initials-field"
                    :model-value="p.initials || ''"
                    outlined
                    dense
                    maxlength="4"
                    :readonly="!w.canEdit"
                    @update:model-value="(v) => w.patchPerson(p.id, { initials: String(v ?? '') })"
                  />
                </td>
                <td>{{ w.items.filter((i) => i.personIds.includes(p.id)).length }}</td>
                <td>
                  <q-btn
                    flat
                    round
                    icon="mail_outline"
                    :disable="!w.canEdit"
                    :aria-label="'Email pack to ' + p.name"
                    @click="emailPacks?.open(p.id)"
                  />
                  <q-btn
                    flat
                    round
                    icon="delete_outline"
                    color="negative"
                    :disable="!w.canEdit"
                    :aria-label="'Delete ' + p.name"
                    @click="removePerson(p.id)"
                  />
                </td>
              </tr>
              <tr v-if="!w.people.length">
                <td colspan="6" class="empty-state">Add the people who make this event happen.</td>
              </tr>
            </tbody>
          </table>
          <table class="reference-table" v-else>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Background</th>
                <th>Text</th>
                <th>Preview</th>
                <th>Session items</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in w.categories"
                :key="c.id"
                @dragover.prevent
                @drop.prevent="reorder(c.id)"
              >
                <td>
                  <span class="drag-handle" :draggable="w.canEdit" @dragstart="drag = c.id">⠿</span>
                </td>
                <td>
                  <q-input
                    :model-value="c.name"
                    outlined
                    dense
                    :readonly="!w.canEdit"
                    @update:model-value="(v) => v && w.patchCategory(c.id, { name: String(v) })"
                  />
                </td>
                <td>
                  <input
                    type="color"
                    :value="c.bg"
                    :disabled="!w.canEdit"
                    :aria-label="c.name + ' background'"
                    @input="
                      w.patchCategory(c.id, { bg: ($event.target as HTMLInputElement).value })
                    "
                  />
                </td>
                <td>
                  <input
                    type="color"
                    :value="c.fg"
                    :disabled="!w.canEdit"
                    :aria-label="c.name + ' text colour'"
                    @input="
                      w.patchCategory(c.id, { fg: ($event.target as HTMLInputElement).value })
                    "
                  />
                </td>
                <td>
                  <span class="pill" :style="{ background: c.bg, color: c.fg }">{{ c.name }}</span>
                </td>
                <td>{{ w.items.filter((i) => i.categoryId === c.id).length }}</td>
                <td>
                  <q-btn
                    flat
                    no-caps
                    :label="c.archived ? 'Unarchive' : 'Archive'"
                    :disable="!w.canEdit"
                    @click="w.patchCategory(c.id, { archived: !c.archived })"
                  /><q-btn
                    flat
                    round
                    icon="delete_outline"
                    :disable="!w.canEdit"
                    color="negative"
                    :aria-label="'Delete ' + c.name"
                    @click="w.removeCategory(c.id).catch(w.fail)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
  <q-dialog v-model="adding" :persistent="saving">
    <q-card class="dialog-card">
      <q-form @submit="createPerson">
        <q-card-section class="q-gutter-sm">
          <h2>Add person</h2>
          <q-input v-model="newName" label="Name" outlined dense autofocus maxlength="300" />
          <q-input
            v-model="newEmail"
            label="Email address (optional)"
            type="email"
            outlined
            dense
            :rules="[
              (value) => !value.trim() || validPersonEmail(value) || 'Enter a valid email address',
            ]"
            lazy-rules
            hide-bottom-space
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" :disable="saving" v-close-popup />
          <q-btn
            type="submit"
            color="primary"
            no-caps
            label="Add person"
            :loading="saving"
            :disable="!w.canEdit || !newName.trim()"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>
