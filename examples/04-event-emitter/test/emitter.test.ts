import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmitter } from '../src/emitter.ts';

type TestEvents = {
  message: { text: string };
  count: number;
  ready: boolean;
};

test('on + emit delivers payload to handler', () => {
  const emitter = createEmitter<TestEvents>();
  let received: TestEvents['message'] | undefined;

  emitter.on('message', (payload) => {
    received = payload;
  });

  emitter.emit('message', { text: 'hello' });

  assert.deepEqual(received, { text: 'hello' });
});

test('multiple handlers fire in registration order', () => {
  const emitter = createEmitter<TestEvents>();
  const calls: string[] = [];

  emitter.on('count', () => {
    calls.push('first');
  });

  emitter.on('count', () => {
    calls.push('second');
  });

  emitter.on('count', () => {
    calls.push('third');
  });

  emitter.emit('count', 1);

  assert.deepEqual(calls, ['first', 'second', 'third']);
});

test('on returns an unsubscribe function that removes the handler', () => {
  const emitter = createEmitter<TestEvents>();
  let callCount = 0;

  const unsubscribe = emitter.on('ready', () => {
    callCount += 1;
  });

  unsubscribe();
  emitter.emit('ready', true);

  assert.equal(callCount, 0);
});

test('once fires at most one time', () => {
  const emitter = createEmitter<TestEvents>();
  const received: number[] = [];

  emitter.once('count', (value) => {
    received.push(value);
  });

  emitter.emit('count', 1);
  emitter.emit('count', 2);
  emitter.emit('count', 3);

  assert.deepEqual(received, [1]);
});

test('off removes a specific handler', () => {
  const emitter = createEmitter<TestEvents>();
  const calls: string[] = [];

  const removedHandler = () => {
    calls.push('removed');
  };

  const retainedHandler = () => {
    calls.push('retained');
  };

  emitter.on('ready', removedHandler);
  emitter.on('ready', retainedHandler);
  emitter.off('ready', removedHandler);

  emitter.emit('ready', true);

  assert.deepEqual(calls, ['retained']);
});

test('emit with no listeners is a no-op', () => {
  const emitter = createEmitter<TestEvents>();

  assert.doesNotThrow(() => {
    emitter.emit('message', { text: 'nobody-listening' });
  });
});

test('removeAllListeners removes listeners for a specific event and for all events', () => {
  const emitter = createEmitter<TestEvents>();
  const calls: string[] = [];

  emitter.on('message', () => {
    calls.push('message');
  });

  emitter.on('count', () => {
    calls.push('count');
  });

  emitter.removeAllListeners('message');
  emitter.emit('message', { text: 'ignored' });
  emitter.emit('count', 1);

  assert.deepEqual(calls, ['count']);

  emitter.removeAllListeners();
  emitter.emit('count', 2);

  assert.deepEqual(calls, ['count']);
});

test('a throwing handler does not prevent later handlers from running', () => {
  const emitter = createEmitter<TestEvents>();
  const calls: string[] = [];
  const expectedError = new Error('boom');

  emitter.on('count', () => {
    calls.push('before-throw');
  });

  emitter.on('count', () => {
    calls.push('throw');
    throw expectedError;
  });

  emitter.on('count', () => {
    calls.push('after-throw');
  });

  assert.throws(() => {
    emitter.emit('count', 42);
  }, expectedError);

  assert.deepEqual(calls, ['before-throw', 'throw', 'after-throw']);
});
