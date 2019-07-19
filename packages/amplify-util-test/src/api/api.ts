import * as fs from 'fs-extra';
import * as dynamoEmulator from '@conduitvc/dynamodb-emulator';
import { AmplifyAppSyncSimulator } from 'amplify-appsync-simulator';
import { add, generate, isCodegenConfigured } from 'amplify-codegen';
import * as path from 'path';
import * as chokidar from 'chokidar';

import { getAmplifyMeta, addCleanupTask } from '../utils';
import { runTransformer } from './run-graphql-transformer';
import { processResources } from '../CFNParser/resource-processor';
import { ResolverOverrides } from './resolver-overrides';
import { ConfigOverrideManager } from '../utils/config-override';
import { configureDDBDataSource, ensureDynamoDBTables } from '../utils/ddb-utils';

export class APITest {
    private apiName: string;
    private transformerResult: any;
    private ddbClient;
    private appSyncSimulator: AmplifyAppSyncSimulator;
    private resolverOverrideManager: ResolverOverrides;
    private watcher: chokidar.FSWatcher;
    private ddbEmulator;
    private configOverrideManager: ConfigOverrideManager;

    async start(context, port: number = 20002, wsPort: number = 20003) {
        try {
            addCleanupTask(context, async context => {
                await this.stop(context);
            });
            this.configOverrideManager = ConfigOverrideManager.getInstance(context);
            this.apiName = await this.getAppSyncAPI(context);
            this.ddbClient = await this.startDynamoDBLocalServer(context);
            const resolverDirectory = await this.getResolverTemplateDirectory(context);
            this.resolverOverrideManager = new ResolverOverrides(resolverDirectory);
            await this.resolverOverrideManager.start();
            const appSyncConfig = await this.runTransformer(context);
            this.appSyncSimulator = new AmplifyAppSyncSimulator(appSyncConfig, {
                port,
                wsPort
            });
            await this.appSyncSimulator.start();
            console.log('AppSync Emulator is running in', this.appSyncSimulator.url);
            this.watcher = await this.registerWatcher(context);
            this.watcher
                .on('add', path => {
                    this.reload(context, path, 'add');
                })
                .on('change', path => {
                    this.reload(context, path, 'change');
                })
                .on('unlink', path => {
                    this.reload(context, path, 'unlink');
                });
            await this.generateTestFrontendExports(context);
            await this.generateCode(context);
        } catch (e) {
            console.error('Failed to start API test server \n', e);
        }
    }

    async stop(context) {
        this.ddbClient = null;
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.ddbEmulator) {
            await this.ddbEmulator.terminate();
            this.ddbEmulator = null;
        }
        await this.appSyncSimulator.stop();
        this.resolverOverrideManager.stop();
    }

    private async runTransformer(context) {
        const { transformerOutput, stack } = await runTransformer(context);
        let config: any = processResources(stack, transformerOutput);
        await this.ensureDDBTables(config);
        this.transformerResult = this.configureDDBDataSource(config);
        const overriddenTemplates = await this.resolverOverrideManager.sync(
            this.transformerResult.mappingTemplates
        );
        return { ...this.transformerResult, mappingTemplates: overriddenTemplates };
    }
    private async generateCode(context, transformerOutput = null) {
        console.log('Running codegen');
        const { projectPath } = context.amplify.getEnvInfo();
        const schemaPath = path.join(
            projectPath,
            'amplify',
            'backend',
            'api',
            this.apiName,
            'build',
            'schema.graphql'
        );
        if (transformerOutput) {
            fs.writeFileSync(schemaPath, transformerOutput.schema);
        }
        if (!isCodegenConfigured(context)) {
            await add(context);
        } else {
            await generate(context);
        }
    }

    private async reload(context, filePath, action) {
        try {
            let shouldReload;
            if (filePath.includes(this.resolverOverrideManager.resolverTemplateRoot)) {
                switch (action) {
                    case 'add':
                        shouldReload = this.resolverOverrideManager.onAdd(filePath);
                        break;
                    case 'change':
                        shouldReload = this.resolverOverrideManager.onChange(filePath);
                        break;
                    case 'unlink':
                        shouldReload = this.resolverOverrideManager.onUnlink(filePath);
                        break;
                }

                if (shouldReload) {
                    console.log('Mapping template change detected. Reloading');
                    const mappingTemplates = this.resolverOverrideManager.sync(
                        this.transformerResult.mappingTemplates
                    );
                    await this.appSyncSimulator.reload({
                        ...this.transformerResult,
                        mappingTemplates
                    });
                }
            } else {
                console.log('reloading....');
                const config = await this.runTransformer(context);
                await this.appSyncSimulator.reload(config);
                await this.generateCode(context);
            }
        } catch (e) {
            console.log('Reloading failed', e);
        }
    }

    private async generateTestFrontendExports(context) {
        await this.generateFrontendExports(context, {
            endpoint: `${this.appSyncSimulator.url}/graphql`,
            name: this.apiName,
            GraphQLAPIKeyOutput: this.transformerResult.appSync.apiKey,
            region: 'local',
            additionalAuthenticationProviders: [],
            securityType: this.transformerResult.appSync.authenticationType
        });
    }
    private async ensureDDBTables(config) {
        const tables = config.tables.map(t => t.Properties);
        await ensureDynamoDBTables(this.ddbClient, config);
    }

    private configureDDBDataSource(config) {
        const ddbConfig = this.ddbClient.config;
        return configureDDBDataSource(config, ddbConfig);
    }
    private async getAppSyncAPI(context) {
        const currentMeta = await getAmplifyMeta(context);
        const { api: apis = {} } = currentMeta;
        let appSyncApi = null;
        let name = null;
        Object.entries(apis).some((entry: any) => {
            if (entry[1].service === 'AppSync' && entry[1].providerPlugin === 'awscloudformation') {
                appSyncApi = entry[1];
                name = entry[0];
                return true;
            }
        });
        if (!name) {
            throw new Error('No AppSync API is added to the project');
        }
        return name;
    }

    private async startDynamoDBLocalServer(context) {
        const { projectPath } = context.amplify.getEnvInfo();
        const dbPath = path.join(projectPath, 'amplify', 'test', 'dynamodb');
        fs.ensureDirSync(dbPath);
        this.ddbEmulator = await dynamoEmulator.launch({
            dbPath,
            port: null
        });
        return dynamoEmulator.getClient(this.ddbEmulator);
    }

    private async getAPIBackendDirectory(context) {
        const { projectPath } = context.amplify.getEnvInfo();
        return path.join(projectPath, 'amplify', 'backend', 'api', this.apiName);
    }

    private async getResolverTemplateDirectory(context) {
        const apiDirectory = await this.getAPIBackendDirectory(context);
        return path.join(apiDirectory, 'resolvers');
    }
    private async registerWatcher(context: any): Promise<chokidar.FSWatcher> {
        const watchDir = await this.getAPIBackendDirectory(context);
        return chokidar.watch(watchDir, {
            interval: 100,
            ignoreInitial: true,
            followSymlinks: false,
            ignored: '**/build/**',
            awaitWriteFinish: true
        });
    }
    private async generateFrontendExports(
        context: any,
        localAppSyncDetails: {
            name: string;
            endpoint: string;
            securityType: string;
            additionalAuthenticationProviders: string[];
            GraphQLAPIKeyOutput?: string;
            region?: string;
        }
    ) {
        const currentMeta = await getAmplifyMeta(context);
        const override = currentMeta.api || {};
        if (localAppSyncDetails) {
            const appSyncApi = override[localAppSyncDetails.name] || { output: {} };
            override[localAppSyncDetails.name] = {
                service: 'AppSync',
                ...appSyncApi,
                output: {
                    ...appSyncApi.output,
                    GraphQLAPIEndpointOutput: localAppSyncDetails.endpoint,
                    projectRegion: localAppSyncDetails.region,
                    aws_appsync_authenticationType: localAppSyncDetails.securityType,
                    GraphQLAPIKeyOutput: localAppSyncDetails.GraphQLAPIKeyOutput
                },
                lastPushTimeStamp: new Date()
            };
        }

        this.configOverrideManager.addOverride('api', override);
        await this.configOverrideManager.generateOverriddenFrontendExports(context);
    }
}
