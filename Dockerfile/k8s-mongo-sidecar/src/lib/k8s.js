var Client = require('node-kubernetes-client');
var config = require('./config');
var util = require("util");

fs = require('fs');

var readToken = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token');

var client = new Client({
  host: config.k8sROServiceAddress,
  namespace: config.namespace,
  protocol: 'https',
  version: 'v1',
  token: readToken
});

var getMongoPods = function getPods(done) {
  console.log('[MyLog] k8s.getMongoPods()');
  client.pods.get(function (err, podResult) {
    if (err) {
      return done(err);
    }
    var pods = [];
    for (var j in podResult) {
      pods = pods.concat(podResult[j].items)
    }
    // MONGO_SIDECAR_POD_LABELS
    var labels = config.mongoPodLabelCollection;
    var results = [];
    for (var i in pods) {
      var pod = pods[i];
      if (podContainsLabels(pod, labels)) {
        results.push(pod);
        console.log('[MyLog] k8s.getMongoPods() pod: ', pod.metadata.name);
      }
    }
    done(null, results);
  });
};

var podContainsLabels = function podContainsLabels(pod, labels) {
  // console.log('[MyLog] podContainsLabels()');
  if (!pod.metadata || !pod.metadata.labels) return false;

  for (var i in labels) {
    var kvp = labels[i];
    if (!pod.metadata.labels[kvp.key] || pod.metadata.labels[kvp.key] != kvp.value) {
      return false;
    }
  }
  return true;
};

var hasLables = function (res, labels) {
    if (!res.metadata || !res.metadata.labels) return false;
    for (var i in labels) {
        var kvp = labels[i];
        if (!res.metadata.labels[kvp.key] || res.metadata.labels[kvp.key] != kvp.value) {
            return false;
        }
    }
    return true;
};

var getNodePortServices = function (done) {
    console.log('[k8s] getNodePortServices()');
    // MONGO_NODEPORT_SERVICE_LABLES
    var labels = config.mongoNodePortSeviceCollection;
    client.services.get(function (err, result) {
        if (err) {
          console.log('[k8s] getNodePortServices err', err);
          return;
        }
        var allServices = [];
        for (var j in result) {
          var items = result[j].items;
          allServices = allServices.concat(result[j].items);
        }
        var nodeporServices = [];
        for (var ii in allServices) {
          if (hasLables(allServices[ii], labels)) {
            nodeporServices = nodeporServices.concat(allServices[ii]);
          }
        }
        for (var iii in nodeporServices) {
          console.log('    nodeporService: ', nodeporServices[iii].metadata.name);  
        }
        done(null, nodeporServices);
    });
}

module.exports = {
  getMongoPods: getMongoPods,
  getNodePortServices:getNodePortServices
};
