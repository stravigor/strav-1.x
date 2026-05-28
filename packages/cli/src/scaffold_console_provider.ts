/**
 * `ScaffoldConsoleProvider` — all `make:*` commands.
 *
 * Apps add it to `bootstrap/providers.ts`. Because all make:* commands
 * set `static providers = []` (boot nothing), the startup cost is zero
 * when a scaffolding command runs.
 */

import { ConsoleProvider } from './console_provider.ts'
import { MakeCommandFile } from './make/make_command_file.ts'
import { MakeController } from './make/make_controller.ts'
import { MakeFactory } from './make/make_factory.ts'
import { MakeJob } from './make/make_job.ts'
import { MakeMail } from './make/make_mail.ts'
import { MakeMiddleware } from './make/make_middleware.ts'
import { MakeMigration } from './make/make_migration.ts'
import { MakeModel } from './make/make_model.ts'
import { MakeNotification } from './make/make_notification.ts'
import { MakePolicy } from './make/make_policy.ts'
import { MakeProvider } from './make/make_provider.ts'
import { MakeRepository } from './make/make_repository.ts'
import { MakeRequest } from './make/make_request.ts'
import { MakeSeeder } from './make/make_seeder.ts'
import { MakeTest } from './make/make_test.ts'

export class ScaffoldConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.scaffold'
  override readonly commands = [
    MakeController,
    MakeMiddleware,
    MakeRequest,
    MakeModel,
    MakeRepository,
    MakeMigration,
    MakeSeeder,
    MakeFactory,
    MakeJob,
    MakeMail,
    MakeNotification,
    MakePolicy,
    MakeProvider,
    MakeCommandFile,
    MakeTest,
  ] as const
}
