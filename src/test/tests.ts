import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import {spy, restore} from 'simple-mock';

import * as mqtt from 'mqtt';
import {MQTTPubSub} from '../mqtt-pubsub';

chai.use(chaiAsPromised);
const expect = chai.expect;

// -------------- Mocking mqtt Client ------------------

let listener;

const publishSpy = spy((channel, message) => listener && listener(channel, message));
const subscribeSpy = spy((topic, options, cb) => cb && cb(null, {...options, topic}));
const unsubscribeSpy = spy((channel, _, cb) => cb && cb(channel));

const mqttPackage = mqtt as Object;

const connect = function () {
  return {
    publish: publishSpy,
    subscribe: subscribeSpy,
    unsubscribe: unsubscribeSpy,
    on: (event, cb) => {
      if (event === 'message') {
        listener = cb;
      }
    },
  };
};

mqttPackage['connect'] = connect;

// -------------- Mocking mqtt Client ------------------

describe('MQTTPubSub', function () {

  const pubSub = new MQTTPubSub();

  it('can subscribe to specific mqtt channel and called when a message is published on it', function (done) {
    let sub;
    const onMessage = message => {
      pubSub.unsubscribe(sub);

      try {
        expect(message).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    };

    pubSub.subscribe('Posts', onMessage).then(subId => {
      expect(subId).to.be.a('number');
      pubSub.publish('Posts', 'test');
      sub = subId;
    }).catch(err => done(err));
  });

  it('can unsubscribe from specific mqtt channel', function (done) {
    pubSub.subscribe('Posts', () => null).then(subId => {
      pubSub.unsubscribe(subId);

      try {
        expect(unsubscribeSpy.callCount).to.equals(1);
        const call = unsubscribeSpy.lastCall;
        expect(call.args).to.have.members(['Posts']);
        done();

      } catch (e) {
        done(e);
      }
    });
  });

  it('cleans up correctly the memory when unsubscribing', function (done) {
    Promise.all([
             pubSub.subscribe('Posts', () => null),
             pubSub.subscribe('Posts', () => null),
           ])
           .then(([subId, secondSubId]) => {
             try {
               // This assertion is done against a private member, if you change the internals, you may want to change that
               expect((pubSub as any).subscriptionMap[subId]).not.to.be.an('undefined');
               pubSub.unsubscribe(subId);

               // This assertion is done against a private member, if you change the internals, you may want to change that
               expect((pubSub as any).subscriptionMap[subId]).to.be.an('undefined');
               expect(() => pubSub.unsubscribe(subId)).to.throw(`There is no subscription of id "${subId}"`);
               pubSub.unsubscribe(secondSubId);
               done();
             } catch (e) {
               done(e);
             }
           });
  });

  it('will not unsubscribe from the mqtt channel if there is another subscriber on it\'s subscriber list', function (done) {
    let lastSubId;
    const onMessage = msg => {
      // Check onMessage support
      pubSub.unsubscribe(lastSubId);
      expect(unsubscribeSpy.callCount).to.equals(1);

      try {
        expect(msg).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    };

    const subscriptionPromises = [
      pubSub.subscribe('Posts', () => {
        done('Not supposed to be triggered');
      }),
      pubSub.subscribe('Posts', onMessage),
    ];

    Promise.all(subscriptionPromises).then(subIds => {
      try {
        expect(subIds.length).to.equals(2);

        pubSub.unsubscribe(subIds[0]);
        expect(unsubscribeSpy.callCount).to.equals(0);

        pubSub.publish('Posts', 'test');
        lastSubId = subIds[1];
      } catch (e) {
        done(e);
      }
    });
  });

  it('will subscribe to mqtt channel only once', function (done) {
    const onMessage = () => null;

    pubSub.subscribe('Posts', onMessage).then(id1 => {
      return pubSub.subscribe('Posts', onMessage)
                   .then(id2 => [id1, id2]);
    }).then(subIds => {
      try {
        expect(subIds.length).to.equals(2);
        expect(subscribeSpy.callCount).to.equals(1);

        pubSub.unsubscribe(subIds[0]);
        pubSub.unsubscribe(subIds[1]);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('can have multiple subscribers and all will be called when a message is published to this channel', function (done) {
    let unSubIds = [];
    let callCount = 0;
    const onMessageSpy = spy(() => {
      callCount++;

      if (callCount === 2) {
        pubSub.unsubscribe(unSubIds[0]);
        pubSub.unsubscribe(unSubIds[1]);

        expect(onMessageSpy.callCount).to.equals(2);
        onMessageSpy.calls.forEach(call => {
          expect(call.args).to.have.members(['test']);
        });

        done();
      }
    });
    const subscriptionPromises = [
      pubSub.subscribe('Posts', onMessageSpy as Function),
      pubSub.subscribe('Posts', onMessageSpy as Function),
    ];

    Promise.all(subscriptionPromises).then(subIds => {
      try {
        expect(subIds.length).to.equals(2);

        pubSub.publish('Posts', 'test');

        unSubIds = subIds;
      } catch (e) {
        done(e);
      }
    });
  });

  it('can publish objects as well', function (done) {
    let unSubId;
    const onMessage = message => {
      pubSub.unsubscribe(unSubId);

      try {
        expect(message).to.have.property('comment', 'This is amazing');
        done();
      } catch (e) {
        done(e);
      }
    };

    pubSub.subscribe('Posts', onMessage).then(subId => {
      try {
        pubSub.publish('Posts', {comment: 'This is amazing'});
        unSubId = subId;
      } catch (e) {
        done(e);
      }
    });
  });

  it('throws if you try to unsubscribe with an unknown id', function () {
    return expect(() => pubSub.unsubscribe(123))
      .to.throw('There is no subscription of id "123"');
  });

  it('can use transform function to convert the trigger name given into more explicit channel name', function (done) {
    const triggerTransform = (trigger, {repoName}) => `${trigger}.${repoName}`;
    const pubsub = new MQTTPubSub({
      triggerTransform,
    });

    let unSubId;
    const validateMessage = message => {
      pubsub.unsubscribe(unSubId);

      try {
        expect(message).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    };

    pubsub.subscribe('comments', validateMessage, {repoName: 'graphql-mqtt-subscriptions'}).then(subId => {
      pubsub.publish('comments.graphql-mqtt-subscriptions', 'test');
      unSubId = subId;
    });

  });

  it('allows to change encodings of messages passed through MQTT broker', function (done) {
    const pubsub = new MQTTPubSub({
      parseMessageWithEncoding: 'base64',
    });

    let unSubId;
    const validateMessage = message => {
      pubsub.unsubscribe(unSubId);

      try {
        expect(message).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    };

    pubsub.subscribe('comments', validateMessage).then(subId => {
      pubsub.publish('comments', 'test');
      unSubId = subId;
    });
  });

  it('allows to QoS for each publish topic', function (done) {
    const pubsub = new MQTTPubSub({
      publishOptions: topic => Promise.resolve({qos: topic === 'comments' ? 2 : undefined}),
    });

    let unSubId;
    const validateMessage = message => {
      pubsub.unsubscribe(unSubId);

      try {
        expect(publishSpy.calls[0].args[2].qos).to.equals(2);
        expect(message).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    };

    pubsub.subscribe('comments', validateMessage).then(subId => {
      pubsub.publish('comments', 'test');
      unSubId = subId;
    });
  });

  it('allows to set QoS for each topic subscription', function (done) {
    const pubsub = new MQTTPubSub({
      subscribeOptions: topic => Promise.resolve({qos: topic === 'comments' ? 2 : undefined}),
      onMQTTSubscribe: (id, granted) => {
        pubsub.unsubscribe(id);
        try {
          expect(granted.topic).to.equals('comments');
          expect(granted.qos).to.equals(2);
          done();
        } catch (e) {
          done(e);
        }
      },
    });

    pubsub.subscribe('comments', () => null).catch(done);
  });

  afterEach('Reset spy count', () => {
    publishSpy.reset();
    subscribeSpy.reset();
    unsubscribeSpy.reset();
  });

  after('Restore mqtt client', () => {
    restore();
  });

});
