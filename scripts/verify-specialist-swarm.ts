import {
  SPECIALIST_DEPARTMENTS,
  defaultDepartmentActivation,
  getSpecialistDepartment,
  getSpecialistProfile,
  listSpecialists,
} from '../packages/core/src/specialists/index.js';

const fail = (message: string): never => {
  throw new Error('[specialist-swarm] ' + message);
};

if (SPECIALIST_DEPARTMENTS.length < 10) fail('expected at least 10 departments');
if (listSpecialists().length < 100) fail('expected at least 100 specialist profiles');

for (const department of SPECIALIST_DEPARTMENTS) {
  if (department.profiles.length === 0) fail(department.id + ' has no specialists');
  for (const specialistId of department.defaultActivation) {
    const profile = getSpecialistProfile(specialistId);
    if (!profile) fail(department.id + ' activates missing specialist ' + specialistId);
    if (!department.profiles.some((candidate) => candidate.id === specialistId)) {
      fail(department.id + ' activates specialist outside department: ' + specialistId);
    }
  }
}

const revenue = getSpecialistDepartment('revenue');
if (!revenue) fail('revenue department missing');

const requiredRevenue = [
  'revenue-chief',
  'prospector',
  'researcher',
  'qualifier',
  'personalizer',
  'sdr',
  'closer',
  'follow-up',
  'crm',
  'customer-success',
  'sales-analytics',
];

const revenueActive = new Set(defaultDepartmentActivation('revenue').map((profile) => profile.id));
for (const id of requiredRevenue) {
  if (!revenueActive.has(id)) fail('revenue default activation missing ' + id);
}

const video = getSpecialistDepartment('video');
if (!video) fail('video department missing');
for (const id of ['source-producer','source-archivist','clipper']) {
  if (!video.profiles.some((profile) => profile.id === id)) fail('video provenance specialist missing ' + id);
}

console.log(JSON.stringify({
  departments: SPECIALIST_DEPARTMENTS.length,
  specialists: listSpecialists().length,
  revenueDefaultActivation: defaultDepartmentActivation('revenue').map((profile) => profile.id),
}, null, 2));
