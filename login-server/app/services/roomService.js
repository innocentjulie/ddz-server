/**
 * Copyright (c) 2015 深圳市辉游科技有限公司.
 */

var logger = require('pomelo-logger').getLogger('pomelo', __filename);
var util = require('util');
var GameRoom = require('../domain/gameRoom');
var utils = require('../util/utils');
var GameTable = require('../domain/gameTable');
var PlayerState = require('../consts/consts').PlayerState;
var Player = require('../domain/player');

var robotService = require('./robotService');
var exp = module.exports;

var roomsMap = {};
var pomeloApp = null;

/**
 * 初始化房间信息
 * @param app
 * @param roomIds
 * @returns {*}
 */
exp.init = function(app, roomIds) {
  logger.info("roomIds: ", roomIds);
  pomeloApp = app;
  //this.robotService = app.get('robotService');

  for (var index=0; index<roomIds.length; index++) {
    var roomId = roomIds[index];
    loadRoom(roomId, function(err, room) {
        logger.info('roomService.init, room:', room);
      if (!!room) {
        roomsMap[room.roomId] = room;
        room.roomService = this;
      } else {
        logger.error('[%s] [RoomService.init] failed to load room[id = %d] error:', pomeloApp.getServerId(), roomId, err );
      }
    });
  }

  return exp;
};

exp.onStartNewGameCallback = null;

/**
 * 根据房间id获取房间实例。
 * @param roomId
 * @returns {*}
 */
exp.getRoom = function(roomId) {
  //logger.info("roomsMap: %j", roomsMap);
  return roomsMap[roomId];
};

/**
 * 重新加载房间信息
 * @param cb
 */
exp.reloadRooms = function(cb) {
  logger.info("[RoomService.reloadRooms] reload rooms...");
  for (var roomId in roomsMap) {
    var room = roomsMap[roomId];
    room.reloadFromDb();
  }

  utils.invokeCallback(cb);
};

/**
 * 玩家进入房间
 * @param player - 玩家
 * @param roomId - 房间id
 * @param lastTableId - 玩家上次进入时的table id
 * @param cb
 */
exp.enterRoom = function(player, roomId, lastTableId, cb) {
  var room = roomsMap[roomId];

  room.startNewGameCallback = cb;
//  if (!room.startNewGameCallback) {
//    room.startNewGameCallback = cb;
//  }

  room.enter(player, lastTableId);
  exp.playerReady(room, player, function(table) {
    //utils.invokeCallback(cb, table);
  });

  return room;

  //var table = room.enter(player, lastTableId);

  // table.setupEvents(engine);
//  table.players.push(player);
//  player.tableId = table.tableId;

  //return table;
};


/**
 * 获取房间指定的table
 * @param roomId
 * @param tableId
 * @returns {*}
 */
exp.getTable = function(roomId, tableId) {
  var room = roomsMap[roomId];
  if (!room)
    return null;
  return room.tablesMap[tableId];
};

/**
 * 玩家离开房间
 * @param roomId
 * @param playerId
 * @param cb
 */
exp.leave = function(roomId, playerId, cb) {
  var room = roomsMap[roomId];
  var player = room.getPlayer(playerId);
  var table = room.getGameTable(player.tableId);
  if (!!table && !!table.pokeGame) {
    pomeloApp.get('cardService').gameOver(table, player, function() {
      utils.invokeCallback(cb, room.leave(playerId));
    });
  } else {
    utils.invokeCallback(cb, room.leave(playerId));
  }

};


exp.cancelTable = function(table, room) {
  //var self = this;
  var index = room.tables.indexOf(table);
  room.tables.splice(index, 1);
  delete room.tablesMap[table.tableId];
  table.room = null;

  for (var playerIndex=0; playerIndex<table.players.length; playerIndex++) {
    var player = table.players[playerIndex];
    player.reset();
    var pIndex = room.readyPlayers.indexOf(player);
    if (pIndex >=0 ) {
      room.readyPlayers.splice(pIndex, 1);
    }

    if (!!player.robot) {
      //this.robotService.releaseRobotPlayers([player]);
      //room.idle_robots.push(player);
      pomeloApp.rpc.robotServer.robotRemote.releaseRobotPlayers.toServer('*',[player], null);
    } else if (!!room.playersMap[player.userId] && !player.connectionLost) {
      room.readyPlayers.unshift(player);
    }
  }

  process.nextTick(function(){
    exp.onPlayerReadyTimeout(room);
  });
};

exp.playerReady = function(room, player, callback) {
  var self = this;
  // this.clearPlayerReadyTimeout();
  var player = room.playersMap[player.userId];
  player.state = PlayerState.READY;
  if (room.readyPlayers.indexOf(player) < 0)
    room.readyPlayers.push(player);

  while (room.readyPlayers.length > 2) {
    var players = room.readyPlayers.splice(0, 3);
    var table = room.arrangeTable(players);
    room.tables.push(table);
    room.tablesMap[table.tableId] = table;

    //utils.invokeCallback(callback, table);
    utils.invokeCallback(self.onStartNewGameCallback, table);
  }

  if (room.readyPlayers.length >0) {
    if (!room.playerReadyTimeout) {
      room.playerReadyTimeout = setTimeout(exp.onPlayerReadyTimeout.bind(this, room), 10 * 1000);
    }
  }
};

exp.onPlayerReadyTimeout = function(room) {
  var self = this;

  if (!!room.playerReadyTimeout) {
    clearTimeout(room.playerReadyTimeout);
    room.playerReadyTimeout = null;
  }

  var readyPlayers = room.readyPlayers.filter(function(p) {return !p.left;});
  if (readyPlayers.length > 0) {
    pomeloApp.rpc.robotServer.robotRemote.idelRobotsCount.toServer('*',{}, function(err, robots_count){
      console.log('[roomService.onPlayerReadyTimeout] robots_count=', robots_count);
      if (robots_count >= readyPlayers.length){
        var players = readyPlayers.splice(0, 3);
        utils.arrayRemove(room.readyPlayers, players);
        pomeloApp.rpc.robotServer.robotRemote.getRobotPlayers.toServer('*',3-players.length, function(err, robotPlayers){
          players = players.concat(robotPlayers);
          for (var robotIndex=0; robotIndex<robotPlayers.length; robotIndex++) {
            robotPlayers[robotIndex].readyForStartGame = true;
          }

          console.log('[roomService.onPlayerReadyTimeout] arrange robots:', players);
          var table = room.arrangeTable(players);
          room.tables.push(table);
          room.tablesMap[table.tableId] = table;

          console.log('this.startNewGameCallback ', room.startNewGameCallback);
          //utils.invokeCallback(room.startNewGameCallback, table);
          utils.invokeCallback(self.onStartNewGameCallback, table);
        });
      }
      else {
        room.playerReadyTimeout = setTimeout(exp.onPlayerReadyTimeout.bind(room), 10 * 1000);
      }
    });
  }


  //
  //if (readyPlayers.length < 3 && readyPlayers.length>0) {
  //  if (this.robotService.idelRobotsCount() >= 3 - readyPlayers.length) {
  //    var players = readyPlayers.splice(0, 3);
  //    utils.arrayRemove(room.readyPlayers, players);
  //    //var robotPlayers = room.idle_robots.splice(0, 3-players.length);
  //    var robotPlayers = this.robotService.getRobotPlayers(3-players.length);
  //    players = players.concat(robotPlayers);
  //    for (var robotIndex=0; robotIndex<robotPlayers.length; robotIndex++) {
  //      robotPlayers[robotIndex].readyForStartGame = true;
  //    }
  //
  //    console.log('[roomSchema.methods.onPlayerReadyTimeout] arrange robots:', players);
  //    var table = room.arrangeTable(players);
  //    room.tables.push(table);
  //    room.tablesMap[table.tableId] = table;
  //
  //    console.log('this.startNewGameCallback ', room.startNewGameCallback);
  //    utils.invokeCallback(room.startNewGameCallback, table);
  //  } else {
  //    room.playerReadyTimeout = setTimeout(exp.onPlayerReadyTimeout.bind(room), 10 * 1000);
  //  }
  //}
};


exp.releaseTable = function(room, table) {
  var index = room.tables.indexOf(table);
  room.tables.splice(index, 1);
  delete room.tablesMap[table.tableId];
  table.room = null;

  for (var playerIndex=0; playerIndex<table.players.length; playerIndex++) {
    var player = table.players[playerIndex];
    if (!!player) {
      player.reset();
      //var pIndex = room.readyPlayers.indexOf(player);
      var pIndex = room.getReadyPlayerIndexByUserId(player.userId);
      if (pIndex >=0 ) {
        room.readyPlayers.splice(pIndex, 1);
      }

      if (player.robot)
      {
        //this.robotService.releaseRobotPlayers([player]);
        pomeloApp.rpc.robotServer.robotRemote.releaseRobotPlayers.toServer('*', [player], null);
        //room.idle_robots.push(player);
      }

    }
  }
};


var loadRoom = function(roomId, callback) {

  GameRoom.findOne({roomId:roomId}, function(err, room) {
    if (!!room) {
      room.initRoom();
    } else {
      logger.error('[RoomService.init] failed to load room[id = %d] error:', roomId, err );
    }
    utils.invokeCallback(callback, err, room);
  });
//
//  var room = new GameRoom({roomId:roomId, roomName: 'room_' + roomId});
//  room.initRoom();
//
//  return room;
};
