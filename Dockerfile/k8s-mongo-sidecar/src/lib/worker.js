var mongo = require('./mongo');
var k8s = require('./k8s');
var config = require('./config');
var ip = require('ip');
var async = require('async');
var moment = require('moment');
var dns = require('dns');
var os = require('os');

var loopSleepSeconds = config.loopSleepSeconds;
var unhealthySeconds = config.unhealthySeconds;

var hostIp = false;
var hostIpAndPort = false;

var init = function(done) {
  //Borrowed from here: http://stackoverflow.com/questions/3653065/get-local-ip-address-in-node-js
  var hostName = os.hostname();
  dns.lookup(hostName, function (err, addr) {
    if (err) {
      return done(err);
    }

    hostIp = addr;
    hostIpAndPort = hostIp + ':' + config.mongoPort;

    done();
  });
};

var workloop = function workloop() {
  var now = new Date().toString();
  console.log('[worker] workloop() ==== ', now, ' ====');
  if (!hostIp || !hostIpAndPort) {
    throw new Error('Must initialize with the host machine\'s addr');
  }
  try {
    //Do in series so if k8s.getMongoPods fails, it doesn't open a db connection
    async.series([
      k8s.getMongoPods,
      mongo.getDb,
      k8s.getNodePortServices
    ], function (err, results) {
      var db = null;
      if (err) {
        if (Array.isArray(results) && results.length === 2) {
          db = results[1];
        }
        return finish(err, db);
      }

      var pods = results[0];
      db = results[1];
      var nodeportServices = results[2];
      mongo.getServerStatus(db);
      //Lets remove any pods that aren't running
      for (var i = pods.length - 1; i >= 0; i--) {
        var pod = pods[i];
        if (pod.status.phase !== 'Running') {
          console.log('[MyLog] remove not running pod ', pod.metadata.name);
          pods.splice(i, 1);
        }
      }
      console.log('[MyLog] pods: ', getMetadataName(pods));
      // console.log('[MyLog] nodeportServices\n', getMetadataName(nodeportServices));

      if (!pods.length) {
        return finish('No pods are currently running, probably just give them some time.');
      }

      //Lets try and get the rs status for this mongo instance
      //If it works with no errors, they are in the rs
      //If we get a specific error, it means they aren't in the rs
      mongo.replSetGetStatus(db, function (err, status) {
        if (err) {
          console.log('[worker][ReplicaSet] replSetGetStatus() ', err);
          if (err.code && err.code == 94) {
            notInReplicaSet(db, pods, nodeportServices, function (err) {
              finish(err, db);
            });
          }
          else if (err.code && err.code == 93) {
            invalidReplicaSet(db, pods, nodeportServices, status, function (err) {
              finish(err, db);
            });
          }
          else {
            finish(err, db);
          }
          return;
        }
        console.log('[worker][ReplicaSet] replSetGetStatus() ok: ', status.ok,', members: ', status.members.length,'\n', status.members);
        inReplicaSet(db, pods, nodeportServices, status, function (err) {
          finish(err, db);
        });
      });
    });
  } catch (err) {
    console.log('[worker] workloop() catched error: ', err);
    // finish(err, db);
  }
};

var finish = function(err, db) {
  var now = new Date().toString();
  console.log('[worker][mongo] finish() ==== ', now.toString(), ' ====');

  if (err) {
    console.error('Error in workloop', err);
  }

  if (db && db.close) {
    db.close();
  }

  setTimeout(workloop, loopSleepSeconds * 1000);
};

var inReplicaSet = function(db, pods, services, status, done) {
  console.log('[worker][ReplicaSet] inReplicaSet()');
  //If we're already in a rs and we ARE the primary, do the work of the primary instance (i.e. adding others)
  //If we're already in a rs and we ARE NOT the primary, just continue, nothing to do
  //If we're already in a rs and NO ONE is a primary, elect someone to do the work for a primary
  var members = status.members;

  var primaryExists = false;
  for (var i in members) {
    var member = members[i];

    if (member.state === 1) {
      if (member.self) {
        return primaryWork(db, pods, services, members, false, done);
      }

      primaryExists = true;
      break;
    }
  }
  console.log('[worker][ReplicaSet] primaryExists: ', primaryExists);
  if (!primaryExists && podElection(pods)) {
    console.log('[worker][ReplicaSet] Pod has been elected as a secondary to do primary work');
    return primaryWork(db, pods, services, members, true, done);
  }

  done();
};

var primaryWork = function(db, pods, services, members, shouldForce, done) {
  console.log('[worker][ReplicaSet] primaryWork()');
  //Loop over all the pods we have and see if any of them aren't in the current rs members array
  //If they aren't in there, add them
  var addrToAdd = addrToAddLoop(pods, services, members);
  var addrToRemove = addrToRemoveLoop(members);

  if (addrToAdd.length || addrToRemove.length) {
    mongo.addNewReplSetMembers(db, addrToAdd, addrToRemove, shouldForce, done);
    return;
  }

  done();
};

var notInReplicaSet = function(db, pods, services, done) {
  console.log('[worker][ReplicaSet] notInReplicaSet()');
  var createTestRequest = function(pod) {
    return function(completed) {
      mongo.isInReplSet(pod.status.podIP, completed);
    };
  };

  //If we're not in a rs and others ARE in the rs, just continue, another path will ensure we will get added
  //If we're not in a rs and no one else is in a rs, elect one to kick things off
  var testRequests = [];
  for (var i in pods) {
    var pod = pods[i];

    if (pod.status.phase === 'Running') {
      testRequests.push(createTestRequest(pod));
    }
  }

  async.parallel(testRequests, function(err, results) {
    if (err) {
      return done(err);
    }

    for (var i in results) {
      if (results[i]) {
        return done(); //There's one in a rs, nothing to do
      }
    }

    if (podElection(pods)) {
      console.log('[worker] notInReplicaSet Pod has been elected for replica set initialization');
      var primary = pods[0]; // After the sort election, the 0-th pod should be the primary.
      console.log("[worker] after election, primary is ", primary.metadata.name);
      var primaryStableNetworkAddressAndPort = getPodStableNetworkAddressAndPort(primary);
      // Prefer the stable network ID over the pod IP, if present.
      var podExternalIpPort = getPodExternalIpPort(primary, services);
      var primaryAddressAndPort = podExternalIpPort || primaryStableNetworkAddressAndPort || hostIpAndPort;
      mongo.initReplSet(db, primaryAddressAndPort, done);
      return;
    }

    done();
  });
};

var invalidReplicaSet = function(db, pods, services, status, done) {
  console.log('[worker][ReplicaSet] invalidReplicaSet()');
  // console.log('[worker] invalidReplicaSet pods: \n', pods);
  // console.log('[worker] invalidReplicaSet services: \n', services);
  // console.log('[worker] invalidReplicaSet status: \n', status);
  // The replica set config has become invalid, probably due to catastrophic errors like all nodes going down
  // this will force re-initialize the replica set on this node. There is a small chance for data loss here
  // because it is forcing a reconfigure, but chances are recovering from the invalid state is more important
  var members = [];
  if (status && status.members) {
    members = status.members;
  }

  console.log("[worker] Invalid set, re-initializing");
  var addrToAdd = addrToAddLoop(pods, services, members);
  var addrToRemove = addrToRemoveLoop(members);

  mongo.addNewReplSetMembers(db, addrToAdd, addrToRemove, true, function(err) {
    done(err, db);
  });
};

var podElection = function(pods) {
  // Because all the pods are going to be running this code independently, we need a way to consistently find the same
  // node to kick things off, the easiest way to do that is convert their ips into longs and find the highest
  pods.sort(function(a,b) {
    try {
        var aIpVal = ip.toLong(a.status.podIP);
        var bIpVal = ip.toLong(b.status.podIP);
        if (aIpVal < bIpVal) return -1;
        if (aIpVal > bIpVal) return 1;
        return 0; // Shouldn't get here... all pods should have different ips
    } catch(err) {
        console.log('[worker][ReplicaSet] podElection error: \n', a, '\n',b);
        return 0; // Shouldn't get here... all pods should have different ips
    }
  });
  // Are we the lucky one?
  return pods[0].status.podIP == hostIp;
};

var addrToAddLoop = function(pods, services, members) {
  console.log('[worker] addrToAddLoop()');
  var addrToAdd = [];
  for (var i in pods) {
    var pod = pods[i];
      console.log('[worker] addrToAddLoop pod_', i, ': ', getMetadataName(pod));
    if (pod.status.phase !== 'Running') {
      console.log('[worker] addrToAddLoop not running, go continue...');
      continue;
    }
    var podExternalIpPort = getPodExternalIpPort(pod, services);
    if (config.clusterExternalIP && !podExternalIpPort) {
      // Maybe the label has not been set yet.
      console.log('[worker] addrToAddLoop No podExternalIpPort, go continue...');
      continue;
    }
    // console.log('[worker] addrToAddLoop podExternalIpPort ', podExternalIpPort);
    var podIpAddr = getPodIpAddressAndPort(pod);
    var podStableNetworkAddr = getPodStableNetworkAddressAndPort(pod);
    var podInRs = false;

    for (var j in members) {
      var member = members[j];
      if (member.name === podIpAddr || member.name === podStableNetworkAddr || member.name === podExternalIpPort) {
        /* If we have the pod's ip or the stable network address already in the config, no need to read it. Checks both the pod IP and the
        * stable network ID - we don't want any duplicates - either one of the two is sufficient to consider the node present. */
        podInRs = true;
        console.log('[worker] addrToAddLoop podInRs, go continue...');
        continue;
      }
    }

    if (!podInRs) {
      // If the node was not present, we prefer the stable network ID, if present.
      var addrToUse = podExternalIpPort || podStableNetworkAddr || podIpAddr;
      addrToAdd.push(addrToUse);
      console.log('[worker] addrToAddLoop push');
    }
  }
  console.log('[worker] addrToAdd result: ', addrToAdd);
  return addrToAdd;
};

var addrToRemoveLoop = function(members) {
  console.log('[worker] addrToRemoveLoop()');
    var addrToRemove = [];
    for (var i in members) {
        var member = members[i];
        if (memberShouldBeRemoved(member)) {
            addrToRemove.push(member.name);
        }
    }
    console.log('[worker] addrToRemove result: ', addrToRemove);
    return addrToRemove;
};

var memberShouldBeRemoved = function(member) {
    return !member.health
        && moment().subtract(unhealthySeconds, 'seconds').isAfter(member.lastHeartbeatRecv);
};

/**
 * @param pod this is the Kubernetes pod, containing the info.
 * @returns string - podIp the pod's IP address with the port from config attached at the end. Example
 * WWW.XXX.YYY.ZZZ:27017. It returns undefined, if the data is insufficient to retrieve the IP address.
 */
var getPodIpAddressAndPort = function(pod) {
  if (!pod || !pod.status || !pod.status.podIP) {
    return;
  }

  return pod.status.podIP + ":" + config.mongoPort;
};

/**
 * Gets the pod's address. It can be either in the form of
 * '<pod-name>.<mongo-kubernetes-service>.<pod-namespace>.svc.cluster.local:<mongo-port>'. See:
 * <a href="https://kubernetes.io/docs/concepts/abstractions/controllers/statefulsets/#stable-network-id">Stateful Set documentation</a>
 * for more details. If those are not set, then simply the pod's IP is returned.
 * @param pod the Kubernetes pod, containing the information from the k8s client.
 * @returns string the k8s MongoDB stable network address, or undefined.
 */
var getPodStableNetworkAddressAndPort = function(pod) {
  if (!config.k8sMongoServiceName || !pod || !pod.metadata || !pod.metadata.name || !pod.metadata.namespace) {
    return;
  }

  var clusterDomain = config.k8sClusterDomain;
  var mongoPort = config.mongoPort;
  return pod.metadata.name + "." + config.k8sMongoServiceName + "." + pod.metadata.namespace + ".svc." + clusterDomain + ":" + mongoPort;
};

var getPodExternalIpPort = function(pod, services) {
  // console.log('[worker] getPodExternalIpPort() pod: ', pod.metadata.name);
  var externalIp = config.clusterExternalIP;
  if (!externalIp)
    return false;
  
  var podLabels = pod.metadata.labels;
  var podPartOfLabels = {};
  // console.log('[worker] getPodExternalIpPort the podlables:\n ', podLabels);
  for (var i in services) {
    var service = services[i];
    var nodeport = service.spec.ports[0].nodePort;
    var selector = service.spec.selector;
    // console.log('[worker] getPodExternalIpPort examinate node port service\n  selector: \n  ', selector
    //   , '\n  nodeport: ', nodeport);
    var selectorKeys = Object.keys(selector);
    for (var ii in selectorKeys) {
      key = selectorKeys[ii];
      if (podLabels[key] === selector[key]) {
        podPartOfLabels[key] = podLabels[key]; 
      }
    }
    // console.log('[worker] getPodExternalIpPort podPartOfLabels: \n', podPartOfLabels);
    if (Object.keys(podPartOfLabels).length === selectorKeys.length) {
      // console.log('[worker] getPodExternalIpPort found service: ', service.metadata.name);
      return externalIp + ':' + nodeport;
    }
  }
  console.log('[worker] getPodExternalIpPort can not find any node service!!!');
  return false;
}

var getMetadataName = function (resources) {
  if (!resources)
    return;
  try {
    if (Array.isArray(resources)) {
      return resources.map(item => item && (item.details ? item.details.name : item.metadata.name));
    } else if (Array.isArray(resources.items)) {
      return resources.items.map(item => item.metadata.name);
    } else if (resources) {
      return resources.metadata.name;
    }
  } catch (error) {
    return error;
  }
}

module.exports = {
  init: init,
  workloop: workloop
};
