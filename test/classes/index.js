'use strict'

const t = require('tap')
t.same(require('../../classes'), {
  SemVer: require('../../classes/semver'),
  Range: require('../../classes/range'),
  Comparator: require('../../classes/comparator'),
  RangeIndex: require('../../classes/range-index'),
}, 'export all classes at semver/classes')
