import { subject } from '@casl/ability';
import {
    ForbiddenError,
    MissingConfigError,
    SemanticLayerField,
    SemanticLayerQuery,
    SemanticLayerQueryPayload,
    SemanticLayerSelectedFields,
    SemanticLayerView,
    SessionUser,
} from '@lightdash/common';
import { LightdashAnalytics } from '../../analytics/LightdashAnalytics';
import { S3Client } from '../../clients/Aws/s3';
import CubeClient from '../../clients/cube/CubeClient';
import DbtCloudGraphqlClient from '../../clients/dbtCloud/DbtCloudGraphqlClient';
import { LightdashConfig } from '../../config/parseConfig';
import Logger from '../../logging/logger';
import { DownloadFileModel } from '../../models/DownloadFileModel';
import { ProjectModel } from '../../models/ProjectModel/ProjectModel';
import { SchedulerClient } from '../../scheduler/SchedulerClient';
import { BaseService } from '../BaseService';

type SearchServiceArguments = {
    lightdashConfig: LightdashConfig;
    analytics: LightdashAnalytics;
    projectModel: ProjectModel;
    downloadFileModel: DownloadFileModel;
    // Clients
    schedulerClient: SchedulerClient;
    cubeClient: CubeClient;
    dbtCloudClient: DbtCloudGraphqlClient;
    s3Client: S3Client;
};

export class SemanticLayerService extends BaseService {
    private readonly analytics: LightdashAnalytics;

    private readonly lightdashConfig: LightdashConfig;

    private readonly projectModel: ProjectModel;

    private readonly downloadFileModel: DownloadFileModel;

    private readonly schedulerClient: SchedulerClient;

    // Clients
    private readonly cubeClient: CubeClient;

    private readonly dbtCloudClient: DbtCloudGraphqlClient;

    private readonly s3Client: S3Client;

    constructor(args: SearchServiceArguments) {
        super();
        this.analytics = args.analytics;
        this.lightdashConfig = args.lightdashConfig;
        this.projectModel = args.projectModel;
        this.downloadFileModel = args.downloadFileModel;
        this.schedulerClient = args.schedulerClient;
        // Clients
        this.cubeClient = args.cubeClient;
        this.dbtCloudClient = args.dbtCloudClient;
        this.s3Client = args.s3Client;
    }

    private async checkCanViewProject(user: SessionUser, projectUuid: string) {
        const project = await this.projectModel.get(projectUuid);
        if (
            user.ability.cannot(
                'view',
                subject('Project', {
                    organizationUuid: project.organizationUuid,
                    projectUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }
        return project;
    }

    async getSemanticLayerClient(
        projectUuid: string,
    ): Promise<CubeClient | DbtCloudGraphqlClient> {
        // TODO: get different client based on project, right now we're only doing this based on config

        if (
            !!this.lightdashConfig.dbtCloud.bearerToken &&
            !!this.lightdashConfig.dbtCloud.environmentId
        ) {
            return this.dbtCloudClient;
        }

        if (
            !!this.lightdashConfig.cube.token &&
            !!this.lightdashConfig.cube.domain
        ) {
            return this.cubeClient;
        }

        throw new MissingConfigError('No semantic layer available');
    }

    async getViews(
        user: SessionUser,
        projectUuid: string,
    ): Promise<SemanticLayerView[]> {
        const { organizationUuid } = await this.checkCanViewProject(
            user,
            projectUuid,
        );

        return this.analytics.wrapEvent<any[]>(
            {
                event: 'semantic_layer.get_views', // started, completed, error suffix when using wrapEvent
                userId: user.userUuid,
                properties: {
                    organizationId: organizationUuid,
                    projectId: projectUuid,
                },
            },
            async () => {
                const client = await this.getSemanticLayerClient(projectUuid);
                return client.getViews();
            },
            // Extra properties for analytic event after the function is executed
            (result) => ({
                viewCount: result.length,
            }),
        );
    }

    async getFields(
        user: SessionUser,
        projectUuid: string,
        view: string,
        selectedFields: SemanticLayerSelectedFields,
    ): Promise<SemanticLayerField[]> {
        await this.checkCanViewProject(user, projectUuid);
        const client = await this.getSemanticLayerClient(projectUuid);
        return client.getFields(view, selectedFields);
    }

    async getStreamingResults(
        user: SessionUser,
        projectUuid: string,
        query: SemanticLayerQuery,
    ) {
        await this.checkCanViewProject(user, projectUuid);
        await this.getSemanticLayerClient(projectUuid); // Check if client is available

        const jobId = await this.schedulerClient.semanticLayerStreamingResults({
            projectUuid,
            userUuid: user.userUuid,
            query,
            context: 'semanticViewer',
        });

        return { jobId };
    }

    async streamQueryIntoFile({
        userUuid,
        projectUuid,
        query,
        context,
    }: SemanticLayerQueryPayload): Promise<{
        fileUrl: string;
    }> {
        // TODO add analytics
        Logger.debug(`Streaming query into file for project ${projectUuid}`);
        const client = await this.getSemanticLayerClient(projectUuid);

        const fileUrl = await this.downloadFileModel.streamFunction(
            this.s3Client,
        )(
            `${this.lightdashConfig.siteUrl}/api/v2/projects/${projectUuid}/semantic-layer/results`,
            async (writer) => {
                await client.streamResults(projectUuid, query, async (rows) => {
                    rows.forEach(writer);
                });
            },
            this.s3Client,
        );

        return { fileUrl };
    }

    async getSql(
        user: SessionUser,
        projectUuid: string,
        query: SemanticLayerQuery,
    ): Promise<string> {
        await this.checkCanViewProject(user, projectUuid);
        const client = await this.getSemanticLayerClient(projectUuid);
        return client.getSql(query);
    }
}