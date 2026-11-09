// Знімок даних закладу для timetable-service (GET /internal/v1/schools/{schoolId}/snapshot).
// Єдиний прямий виклик між сервісами (розділ 03). Читається однією транзакцією REPEATABLE READ,
// тож snapshot_version точно відповідає даним.
import { withSchoolSnapshot, type Db } from '../db/index.js';
import { readClasses, readSubjects, type SchoolClass, type Subject } from './classes.js';
import { readCurriculum, type CurriculumRow } from './curriculum.js';
import { EMPTY_PROFILE, getBellsIn, type Bell, type SchoolProfile } from './profile.js';
import { readTeachers, type Teacher } from './teachers.js';

export interface Snapshot {
  school_id: string;
  snapshot_version: number;
  profile: Omit<SchoolProfile, 'snapshot_version'>;
  bells: Bell[];
  /** Усі класи, предмети й вчителі, зокрема архівовані й видалені (з archived_at / deleted_at). */
  classes: SchoolClass[];
  subjects: Subject[];
  teachers: Teacher[];
  curriculum: CurriculumRow[];
}

export async function getSnapshot(db: Db, schoolId: string): Promise<Snapshot> {
  return withSchoolSnapshot(db, schoolId, async (trx) => {
    const profile = await trx.selectFrom('school_profile').selectAll().where('school_id', '=', schoolId).executeTakeFirst();
    const [bells, classes, subjects, teachers, curriculum] = await Promise.all([
      getBellsIn(trx),
      readClasses(trx),
      readSubjects(trx),
      readTeachers(trx),
      readCurriculum(trx),
    ]);
    return {
      school_id: schoolId,
      snapshot_version: profile?.snapshot_version ?? 0,
      profile: profile
        ? {
            name: profile.name ?? '',
            lessons_per_day: profile.lessons_per_day,
            saturday: profile.saturday,
            shelter_capacity: profile.shelter_capacity,
            non_teaching_staff: profile.non_teaching_staff,
            shelter_seats: profile.shelter_seats,
          }
        : {
            name: EMPTY_PROFILE.name,
            lessons_per_day: EMPTY_PROFILE.lessons_per_day,
            saturday: EMPTY_PROFILE.saturday,
            shelter_capacity: EMPTY_PROFILE.shelter_capacity,
            non_teaching_staff: EMPTY_PROFILE.non_teaching_staff,
            shelter_seats: EMPTY_PROFILE.shelter_seats,
          },
      bells,
      classes,
      subjects,
      teachers,
      curriculum,
    };
  });
}
