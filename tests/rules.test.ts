import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  writeBatch,
  Timestamp,
  deleteDoc,
} from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import { readFileSync } from 'node:fs';
let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rundown',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  await env.withSecurityRulesDisabled(async (c) => {
    await deleteDoc(doc(c.firestore(), 'tenants/b/members/new'));
    await deleteDoc(doc(c.firestore(), 'tenants/b'));
  });
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'tenants/a'), { name: 'A', createdBy: 'owner' });
    for (const role of ['owner', 'editor', 'viewer'])
      await setDoc(doc(db, `tenants/a/members/${role}`), { role });
    await setDoc(doc(db, 'tenants/a/categories/music'), {
      name: 'Music',
      bg: '#ffffff',
      fg: '#000000',
      order: 0,
    });
    await setDoc(doc(db, 'tenants/a/events/event'), {
      name: 'Event',
      timeZone: 'Australia/Brisbane',
      startDate: '2027-03-27',
      endDate: '2027-03-27',
    });
  });
});
it('blocks unauthenticated and cross-tenant reads', async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'tenants/a')));
  await assertFails(
    getDoc(doc(env.authenticatedContext('outsider').firestore(), 'tenants/a/events/event')),
  );
});
it('permits viewer reads but no edits', async () => {
  const db = env.authenticatedContext('viewer').firestore();
  await assertSucceeds(getDoc(doc(db, 'tenants/a/events/event')));
  await assertFails(updateDoc(doc(db, 'tenants/a/events/event'), { name: 'Changed' }));
});
it('allows editor data changes but prevents escalation and export-job forgery', async () => {
  const db = env.authenticatedContext('editor').firestore();
  await assertSucceeds(updateDoc(doc(db, 'tenants/a/events/event'), { name: 'Changed' }));
  await assertFails(updateDoc(doc(db, 'tenants/a/members/editor'), { role: 'owner' }));
  await assertFails(setDoc(doc(db, 'tenants/a/exportJobs/job'), { status: 'complete' }));
});
it('requires atomic tenant-owner bootstrap and immutable creator', async () => {
  const db = env.authenticatedContext('new').firestore();
  await assertFails(setDoc(doc(db, 'tenants/b'), { name: 'B', createdBy: 'new' }));
  const b = writeBatch(db);
  b.set(doc(db, 'tenants/b'), { name: 'B', createdBy: 'new' });
  b.set(doc(db, 'tenants/b/members/new'), { role: 'owner' });
  await assertSucceeds(b.commit());
  await assertFails(updateDoc(doc(db, 'tenants/b'), { createdBy: 'other' }));
});
it('prevents a creator who lost membership from reclaiming ownership', async () => {
  await env.withSecurityRulesDisabled(async (c) =>
    setDoc(doc(c.firestore(), 'tenants/a'), { name: 'A', createdBy: 'removed' }),
  );
  await assertFails(
    setDoc(doc(env.authenticatedContext('removed').firestore(), 'tenants/a/members/removed'), {
      role: 'owner',
    }),
  );
});
it('rejects invalid item durations, missing categories and forged editor IDs', async () => {
  const db = env.authenticatedContext('editor').firestore(),
    ref = doc(db, 'tenants/a/events/event/sessions/session/items/item');
  const item = {
    title: 'Cue',
    durationSec: 60,
    order: 'a0',
    categoryId: 'music',
    personIds: [],
    av: {},
    updatedBy: 'editor',
  };
  await assertSucceeds(setDoc(ref, item));
  await assertFails(updateDoc(ref, { durationSec: -1 }));
  await assertFails(updateDoc(ref, { durationSec: 1.5 }));
  await assertFails(updateDoc(ref, { categoryId: 'absent' }));
  await assertFails(updateDoc(ref, { updatedBy: 'owner' }));
});
it('locks uploaded images to tenant members and image types', async () => {
  const path = 'tenants/a/events/event/sessions/session/items/item/test.png';
  await assertSucceeds(
    uploadBytes(
      ref(env.authenticatedContext('editor').storage(), path),
      new Uint8Array([137, 80, 78, 71]),
      { contentType: 'image/png' },
    ),
  );
  await assertFails(
    uploadBytes(ref(env.authenticatedContext('viewer').storage(), path), new Uint8Array([1]), {
      contentType: 'image/png',
    }),
  );
  await assertFails(
    uploadBytes(ref(env.authenticatedContext('outsider').storage(), path), new Uint8Array([1]), {
      contentType: 'image/png',
    }),
  );
  await assertFails(
    uploadBytes(ref(env.authenticatedContext('editor').storage(), path), new Uint8Array([1]), {
      contentType: 'text/html',
    }),
  );
});
