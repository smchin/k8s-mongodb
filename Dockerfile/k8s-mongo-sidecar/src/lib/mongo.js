var Db = require('mongodb').Db;
var MongoServer = require('mongodb').Server;
var async = require('async');
var config = require('./config');

var localhost = '127.0.0.1'; //Can access mongo as localhost from a sidecar

var getDbWithClient = function(host, done) {
  console.log('[mongo] getDbWithClient()');
    //If they called without host like getDb(function(err, db) { ... });
  if (arguments.length === 1) {
    if (typeof arguments[0] === 'function') {
      done = arguments[0];
      host = localhost;
    } else {
      throw new Error('getDb illegal invocation. User either getDb(\'options\', function(err, db) { ... }) OR getDb(function(err, db) { ... })');
    }
  }

  console.log('[mongo] getDbWithClient() host:', host);
}

var getDb = function(host, done) {
  console.log('[mongo] getDb()');
  //If they called without host like getDb(function(err, db) { ... });
  if (arguments.length === 1) {
    if (typeof arguments[0] === 'function') {
      done = arguments[0];
      host = localhost;
    } else {
      throw new Error('getDb illegal invocation. User either getDb(\'options\', function(err, db) { ... }) OR getDb(function(err, db) { ... })');
    }
  }

  var mongoOptions = {};
  host = host || localhost;

  if (config.mongoSSLEnabled) {
    mongoOptions = {
      ssl: config.mongoSSLEnabled,
      sslAllowInvalidCertificates: config.mongoSSLAllowInvalidCertificates,
      sslAllowInvalidHostnames: config.mongoSSLAllowInvalidHostnames
    }
  }

  var mongoDb = new Db(config.database, new MongoServer(host, config.mongoPort, mongoOptions));

  mongoDb.open(function (err, db) {
    if (err) {
      return done(err);
    }

    if(config.username) {
        mongoDb.authenticate(config.username, config.password, function(err, result) {
            if (err) {
              return done(err);
            }

            return done(null, db);
        });
    } else {
      return done(null, db);
    }

  });
};

var replSetGetConfig = function(db, done) {
  // console.log('[mongo] replSetGetConfig()');
  db.admin().command({ replSetGetConfig: 1 }, {}, function (err, results) {
    if (err) {
      console.log('[mongo] replSetGetConfig() error: \n', err);
      return done(err);
    }
    console.log('[mongo] replSetGetConfig() config: \n', results.config);
    return done(null, results.config);
  });
};

var replSetGetStatus = function(db, done) {
  // console.log('[mongo] replSetGetStatus()');
  db.admin().command({ replSetGetStatus: {} }, {}, function (err, results) {
    if (err) {
      // console.log('[mongo] replSetGetStatus() error: \n', err);
      return done(err);
    }
    // console.log('[mongo] replSetGetStatus() results: \n', results);
    return done(null, results);
  });
};

var initReplSet = function(db, hostIpAndPort, done) {
  console.log('[mongo] initReplSet()', hostIpAndPort);

  db.admin().command({ replSetInitiate: {} }, {}, function (err) {
    if (err) {
      return done(err);
    }

    //We need to hack in the fix where the host is set to the hostname which isn't reachable from other hosts
    replSetGetConfig(db, function(err, rsConfig) {
      if (err) {
        return done(err);
      }

      console.log('[mongo] initial rsConfig is', rsConfig);
      rsConfig.configsvr = config.isConfigRS;
      rsConfig.members[0].host = hostIpAndPort;
      async.retry({times: 20, interval: 500}, function(callback) {
        replSetReconfig(db, rsConfig, false, callback);
      }, function(err, results) {
        if (err) {
          console.log('[mongo] initReplSet replSetReconfig error\n', err);
          return done(err);
        }
        console.log('[mongo] initReplSet replSetReconfig results\n', results);
        return done();
      });
    });
  });
};

var replSetReconfig = function(db, rsConfig, force, done) {
  console.log('[mongo] replSetReconfig()', rsConfig);
  if (!force) {
    rsConfig.version++;
  }

  db.admin().command({ replSetReconfig: rsConfig, force: force }, {}, function (err) {
    if (err) {
      return done(err);
    }

    return done();
  });
};

var addNewReplSetMembers = function(db, addrToAdd, addrToRemove, shouldForce, done) {
  console.log('[mongo] addNewReplSetMembers() shouldForce: ', shouldForce);
  replSetGetConfig(db, function(err, rsConfig) {
    if (err) {
      return done(err);
    }
    if (!shouldForce) {
      removeDeadMembers(rsConfig, addrToRemove, shouldForce);
      addNewMembers(rsConfig, addrToAdd, shouldForce);
    } else {
      replSetReconfigMembers(rsConfig, addrToAdd);
    }

    replSetReconfig(db, rsConfig, shouldForce, done);
  });
};

var replSetReconfigMembers = function(rsConfig, addrsToAdd) {
  console.log('[mongo] replSetReconfigMembers()');
  var candidates = addrsToAdd.slice(0);
  var members = rsConfig.members;
  var newMembers = new Array();
  var member;
  for (var i in members) {
    for (var j in candidates) {
      if (members[i].host === candidates[j]) {
        member = {_id: members[i]._id, host: members[i].host};
        console.log('[mongo] replSetReconfigMembers add: ', member);
        newMembers.push(member);
        candidates.splice(j,1);
        break;
      }
    }
  }
  console.log('[mongo] replSetReconfigMembers candidates: ', candidates);
  if (candidates.length > 0) {
    var max = 0;
    for (var i in newMembers) {
      if (newMembers[i]._id > max) {
        max = newMembers[i]._id;
      }
    }
    for (var j in candidates) {
      member = {_id: ++max, host: candidates[j]};
      console.log('[mongo] replSetReconfigMembers add: ', member);
      newMembers.push(member);
    }
  }
  rsConfig.members = newMembers;
};

var addNewMembers = function(rsConfig, addrsToAdd) {
  console.log('[mongo] addNewMembers()');
  if (!addrsToAdd || !addrsToAdd.length) return;

  //Follows what is basically in mongo's rs.add function
  var max = 0;

  for (var j in rsConfig.members) {
    if (rsConfig.members[j]._id > max) {
      max = rsConfig.members[j]._id;
    }
  }

  for (var i in addrsToAdd) {
    var cfg = {
      _id: ++max,
      host: addrsToAdd[i]
    };

    rsConfig.members.push(cfg);
  }
};

var removeDeadMembers = function(rsConfig, addrsToRemove) {
  console.log('[mongo] removeDeadMembers()');
  if (!addrsToRemove || !addrsToRemove.length) return;

  for (var i in addrsToRemove) {
    var addrToRemove = addrsToRemove[i];
    for (var j in rsConfig.members) {
      var member = rsConfig.members[j];
      if (member.host === addrToRemove) {
        rsConfig.members.splice(j, 1);
        break;
      }
    }
  }
};

var isInReplSet = function(ip, done) {
  console.log('[mongo] isInReplSet()');
  getDb(ip, function(err, db) {
    if (err) {
      return done(err);
    }

    replSetGetConfig(db, function(err, rsConfig) {
      db.close();
      if (!err && rsConfig) {
        done(null, true);
      }
      else {
        done(null, false);
      }
    });
  });
};

var getServerStatus = function(db) {
  db.admin().command({ serverStatus: 1 }, {}, function (err, results) {
    if (err) {
      console.log('[mongo] getServerStatus() ', err.name, ': ', err.messages);
      return;
    }
    console.log('[mongo] getServerStatus() connection: ', results.connections);
    return ;
  });
}

module.exports = {
  getDb: getDb,
  getDbWithClient: getDbWithClient,
  replSetGetStatus: replSetGetStatus,
  initReplSet: initReplSet,
  addNewReplSetMembers: addNewReplSetMembers,
  isInReplSet: isInReplSet,
  getServerStatus: getServerStatus
};