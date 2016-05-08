/**
 * TaskController
 *
 * @module    :: Controller
 * @description :: Interaction with tasks
 */
var taskUtil = require('../services/utils/task');
var userUtil = require('../services/utils/user');
// TODO var exportUtil = require('../services/utils/export');
var i18n = require('i18next');

module.exports = {
  // note: policy addUserId will make the logged in user the owner
  create: function (req, res) {
    var attrs = req.body;
    sails.log.verbose("creating task:",attrs)
    Task.create(attrs)
    .then(function(task) {
      task.owner = req.user.toJSON();
      res.status(201); // created
      res.json(task)
    })
    .catch(res.negotiate);
  },

  // by default update will populate with volunteers
  // but the client doesn't expect that, so we override this
  update: function (req, res) {
    sails.log.verbose("update task:",req.task)
    sails.log.verbose("values:",req.body)
    var taskId = req.params.id
    req.body.id = taskId;
    req.task.updateAction(req.body)
    .then(function(task) {
      res.status(200);    // created
      res.json(task); // tasks are unique by id
    })
    .catch(res.negotiate);
  },

  find: function (req, res) {
    sails.log.verbose('Task.find', req.params);
    var user = req.user,
        taskId = req.params['id'],
        where = {};

    if (taskId) {
      Task.findOneById(taskId)
      .populate('tags')
      .populate('owner')
      .populate('volunteers')
      .exec(function(err, task) {
        if (err) { return res.negotiate(err) }
        if (!task) { return res.notFound('Error finding task.'); }
        task = task.authorized(user);
        if (!task) { return res.forbidden('Task not found.'); }
        return res.send(task);
      });
    } else {
      // Only show drafts for current user
      if (user) {
        where = { or: [{
          state: {'!': 'draft'}
        }, {
          state: 'draft',
          userId: user.id
        }]};
      } else {
        where.state = {'!': 'draft'};
      }

      // run the common task find query
      taskUtil.findTasks(where, function (err, tasks) {
        if (err) { return res.send(400, err); }
        return res.send({ tasks: tasks });
      });
    }
  },

  findOne: function(req, res) {
    sails.log.verbose('Task.findOne')
    module.exports.find(req, res);
  },

  copy: function(req, res) {
    Task.findOneById(req.body.taskId)
    .populate('tags')
    .exec(function(err, task) {
      if (err) return res.send(err, 500);

      // Create a new task draft, copying over the following from the original:
      // projectId, title, description, tags
      var taskCopyData = {
        title: req.body.title !== undefined ? req.body.title : task.title,
        description: task.description,
        userId: req.body.userId,
        state: 'draft',
        tags: task.tags
      };

      Task.create(taskCopyData)
      .exec(function(err, newTask) {
        if (err) return res.send(err, 500);

        res.send({ taskId: newTask.id, title: newTask.title });
      });
    });
  },

  export: function (req, resp) {
    Task.find().exec(function (err, tasks) {
      if (err) {
        sails.log.error("task query error. " + err);
        resp.send(400, {message: 'Error when querying tasks.', error: err});
        return;
      }
      sails.log.debug('task export: found %s tasks', tasks.length)

      User.find({id: _.pluck(tasks, 'userId')}).populate('tags').exec(function (err, creators) {
        if (err) {
          sails.log.error("task creator query error. " + err);
          resp.send(400, {message: 'Error when querying task creators.', error: err});
          return;
        }
        sails.log.debug('task export: found %s creators', creators.length)
        for (var i=0; i < tasks.length; i++) {
          var creator = _.findWhere(creators, {id: tasks[i].userId});
          tasks[i].creator_name = creator ? creator.name : "";
          creator.agency = _.findWhere(creator.tags, {type: 'agency'});
          tasks[i].agency_name = creator && creator.agency ? creator.agency.name : "";
        }

        var processVolunteerQuery = function (err, volQueryResult) {
          if (err) {
            sails.log.error("volunteer query error. " + err);
            resp.send(400, {message: 'Error when counting volunteers', error: err});
            return;
          }
          var volunteers = volQueryResult.rows;
          sails.log.debug('task export: found %s task volunteer counts', volunteers ? volunteers.length : 0)
          for (var i=0; i < tasks.length; i++) {
            var taskVols = _.findWhere(volunteers, {id: tasks[i].id});
            tasks[i].signups = taskVols ? parseInt(taskVols.count) : 0;
          }
          // gathered all data, render and return as file for download
          exportUtil.renderCSV(Task, tasks, function (err, rendered) {
            if (err) {
              sails.log.error("task export render error. " + err);
              resp.send(400, {message: 'Error when rendering', error: err})
              return;
            }
            resp.set('Content-Type', 'text/csv');
            resp.set('Content-disposition', 'attachment; filename=tasks.csv');
            resp.send(200, rendered);
          });
        };

        // Waterline ORM groupby/count doesn't work yet, so query manually
        if ('query' in Volunteer) {
          var sql = 'SELECT "taskId" AS id, sum(1) AS count FROM volunteer GROUP BY "taskId"';
          Volunteer.query(sql, processVolunteerQuery);
        } else {
          sails.log.info("bypassing volunteer query, must be in a test");
          // Since our testing backend doesn't handle sql, we need to bypass
          processVolunteerQuery(null, []);
        }
      });
    });
  }

};
