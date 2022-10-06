import { v4 as uuidv4 } from "uuid"
import { QueryRunner, Raw } from "typeorm"
import SwaggerParser from "@apidevtools/swagger-parser"
import Converter from "swagger2openapi"
import yaml from "js-yaml"
import YAML from "yaml"
import OpenAPIRequestValidator from "@leoscope/openapi-request-validator"
import OpenAPIResponseValidator, {
  OpenAPIResponseValidatorValidationError,
} from "@leoscope/openapi-response-validator"
import { AlertType, RestMethod, SpecExtension } from "@common/enums"
import {
  ApiEndpoint,
  ApiTrace,
  DataField,
  OpenApiSpec,
  Alert,
  AggregateTraceDataHourly,
} from "models"
import { JSONValue, OpenApiSpec as OpenApiSpecResponse } from "@common/types"
import { getPathTokens } from "@common/utils"
import { AppDataSource } from "data-source"
import { getPathRegex, isParameter, parsedJsonNonNull } from "utils"
import Error409Conflict from "errors/error-409-conflict"
import Error422UnprocessableEntity from "errors/error-422-unprocessable-entity"
import {
  generateAlertMessageFromReqErrors,
  generateAlertMessageFromRespErrors,
  getOpenAPISpecVersion,
  getSpecRequestParameters,
  getSpecResponses,
  parsePathParameter,
  SpecValue,
  AjvError,
  validateSpecSchema,
  getSpecRequestBody,
  getHostsV3,
  getServersV3,
} from "./utils"
import { AlertService } from "services/alert"
import Error404NotFound from "errors/error-404-not-found"
import { BlockFieldsService } from "services/block-fields"
import Error500InternalServer from "errors/error-500-internal-server"
import { RISK_SCORE_ORDER } from "~/constants"
import {
  insertDataFieldQuery,
  insertAggregateHourlyQuery,
  deleteOpenAPISpecDiffAlerts,
} from "./queries"

interface EndpointsMap {
  endpoint: ApiEndpoint
  similarEndpoints: Record<string, ApiEndpoint>
}

export class SpecService {
  static async getSpec(specName: string): Promise<OpenApiSpecResponse> {
    const openApiSpecRepository = AppDataSource.getRepository(OpenApiSpec)
    const spec = await openApiSpecRepository.findOneBy({ name: specName })
    return spec
  }

  static async getSpecs(
    listAutogenerated: boolean = true,
  ): Promise<OpenApiSpecResponse[]> {
    const openApiSpecRepository = AppDataSource.getRepository(OpenApiSpec)
    const specList = await openApiSpecRepository.find({
      where: { isAutoGenerated: listAutogenerated },
      order: { updatedAt: "DESC" },
    })
    return specList
  }

  static async updateSpec(
    specObject: JSONValue,
    fileName: string,
    extension: SpecExtension,
    specString: string,
  ): Promise<void> {
    const specVersion = getOpenAPISpecVersion(specObject)
    if (!specVersion) {
      throw new Error422UnprocessableEntity(
        "Invalid OpenAPI Spec: No 'swagger' or 'openapi' field defined.",
      )
    }
    const validationErrors = validateSpecSchema(specObject)
    if (validationErrors?.length > 0) {
      throw new Error422UnprocessableEntity("Invalid OpenAPI Spec", {
        message: "Invalid OpenAPI Spec",
        errors: validationErrors,
      })
    }
    const queryRunner = AppDataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    try {
      await this.deleteSpec(fileName)
      await this.uploadNewSpec(specObject, fileName, extension, specString)
      await queryRunner.commitTransaction()
    } catch (err) {
      console.error(`Error updating spec file: ${err}`)
      await queryRunner.rollbackTransaction()
      throw err
    } finally {
      await queryRunner.release()
    }
  }

  static async deleteSpec(
    fileName: string,
    existingQueryRunner?: QueryRunner,
  ): Promise<void> {
    let queryRunner: QueryRunner
    if (existingQueryRunner) {
      queryRunner = existingQueryRunner
    } else {
      queryRunner = AppDataSource.createQueryRunner()
      await queryRunner.connect()
      await queryRunner.startTransaction()
    }
    try {
      const openApiSpec = await queryRunner.manager.findOneBy(OpenApiSpec, {
        name: fileName,
      })
      if (!openApiSpec) {
        throw new Error404NotFound(
          "No spec file with the provided name exists.",
        )
      }
      if (openApiSpec.isAutoGenerated) {
        throw new Error409Conflict("Can't delete auto generated spec.")
      }
      await queryRunner.query(deleteOpenAPISpecDiffAlerts, [fileName])
      await queryRunner.manager
        .createQueryBuilder()
        .update(ApiEndpoint)
        .set({ openapiSpecName: null })
        .where('"openapiSpecName" = :name', { name: fileName })
        .execute()
      await queryRunner.manager
        .createQueryBuilder()
        .delete()
        .from(OpenApiSpec)
        .where("name = :name", { name: fileName })
        .execute()
      if (!existingQueryRunner) {
        await queryRunner.commitTransaction()
      }
    } catch (err) {
      if (!existingQueryRunner) {
        console.error(`Error deleting spec file: ${err}`)
        await queryRunner.rollbackTransaction()
      }
      throw err
    } finally {
      if (!existingQueryRunner) {
        await queryRunner.release()
      }
    }
  }

  static async uploadNewSpec(
    specObject: JSONValue,
    fileName: string,
    extension: SpecExtension,
    specString: string,
    existingQueryRunner?: QueryRunner,
  ): Promise<void> {
    const currTime = new Date()
    const specVersion = getOpenAPISpecVersion(specObject)
    if (!specVersion) {
      throw new Error422UnprocessableEntity(
        "Invalid OpenAPI Spec: No 'swagger' or 'openapi' field defined.",
      )
    }
    const validationErrors = validateSpecSchema(specObject, specVersion)
    if (validationErrors?.length > 0) {
      throw new Error422UnprocessableEntity("Invalid OpenAPI Spec", {
        message: "Invalid OpenAPI Spec",
        errors: validationErrors,
      })
    }
    if (specVersion === 2) {
      const convertedSpec = await Converter.convertObj(specObject, {})
      if (!convertedSpec?.openapi) {
        throw new Error500InternalServer(
          "Unable to convert swagger spec to OpenAPI V3.",
        )
      }
      specObject = convertedSpec.openapi
      if (extension === SpecExtension.YAML) {
        const doc = new YAML.Document()
        doc.contents = specObject as any
        specString = doc.toString()
      } else {
        specString = JSON.stringify(specObject, null, 2)
      }
    }

    const paths: JSONValue = specObject["paths"]

    const apiEndpointRepository = AppDataSource.getRepository(ApiEndpoint)
    const openApiSpecRepository = AppDataSource.getRepository(OpenApiSpec)

    let existingSpec = await openApiSpecRepository.findOneBy({
      name: fileName,
    })
    if (!existingSpec) {
      existingSpec = new OpenApiSpec()
      existingSpec.name = fileName
      existingSpec.extension = extension
      existingSpec.createdAt = currTime
    }
    existingSpec.spec = specString
    existingSpec.specUpdatedAt = currTime
    existingSpec.updatedAt = currTime
    const pathKeys = Object.keys(paths)
    const endpointsMap: Record<string, EndpointsMap> = {}
    let specHosts: Set<string> = new Set()
    for (const path of pathKeys) {
      const pathRegex = getPathRegex(path)
      const methods = Object.keys(paths[path])?.filter(key =>
        Object.values(RestMethod).includes(key.toUpperCase() as RestMethod),
      )
      for (const method of methods) {
        let hosts: Set<string> = new Set()
        const servers = getServersV3(specObject, path, method)
        if (!servers || servers?.length === 0) {
          throw new Error422UnprocessableEntity(
            "No servers found in spec file.",
          )
        }
        hosts = getHostsV3(servers)
        specHosts = new Set([...specHosts, ...hosts])
        for (const host of hosts) {
          // For exact endpoint match
          let created = false
          let updated = false
          const methodEnum = method.toUpperCase() as RestMethod
          let apiEndpoint = await apiEndpointRepository.findOne({
            where: {
              path,
              method: methodEnum,
              host,
            },
            relations: { openapiSpec: true },
          })
          if (!apiEndpoint) {
            apiEndpoint = new ApiEndpoint()
            apiEndpoint.uuid = uuidv4()
            apiEndpoint.path = path
            apiEndpoint.pathRegex = pathRegex
            apiEndpoint.method = methodEnum
            apiEndpoint.host = host
            apiEndpoint.openapiSpec = existingSpec
            apiEndpoint.addNumberParams()
            created = true
          } else if (
            apiEndpoint &&
            (!apiEndpoint.openapiSpecName ||
              apiEndpoint.openapiSpec?.isAutoGenerated)
          ) {
            apiEndpoint.openapiSpec = existingSpec
            apiEndpoint.openapiSpecName = existingSpec.name
            updated = true
          } else {
            throw new Error409Conflict(
              `Path ${apiEndpoint.path} defined in the given new spec file is already defined in another user defined spec file: ${apiEndpoint.openapiSpecName}`,
            )
          }
          endpointsMap[apiEndpoint.uuid] = {
            endpoint: apiEndpoint,
            similarEndpoints: {},
          }

          if (updated) {
            Object.keys(endpointsMap).forEach(uuid => {
              if (endpointsMap[uuid]?.similarEndpoints?.[apiEndpoint.uuid]) {
                delete endpointsMap[uuid]?.similarEndpoints[apiEndpoint.uuid]
              }
            })
          }
          if (created) {
            const similarEndpoints = await apiEndpointRepository.find({
              where: {
                path: Raw(alias => `${alias} ~ :pathRegex`, { pathRegex }),
                method: methodEnum,
                host,
              },
            })
            similarEndpoints.forEach(item => {
              let exists = false
              if (!endpointsMap[item.uuid]) {
                Object.keys(endpointsMap).forEach(uuid => {
                  if (endpointsMap[uuid]?.similarEndpoints?.[item.uuid]) {
                    exists = true
                    if (
                      apiEndpoint.numberParams === item.numberParams ||
                      (endpointsMap[uuid].endpoint?.numberParams !==
                        item.numberParams &&
                        apiEndpoint.numberParams <
                          endpointsMap[uuid].endpoint?.numberParams)
                    ) {
                      delete endpointsMap[uuid].similarEndpoints[item.uuid]
                      exists = false
                    }
                  }
                })
              }
              if (!exists) {
                endpointsMap[apiEndpoint.uuid].similarEndpoints[item.uuid] =
                  item
              }
            })
          }
        }
      }
    }
    existingSpec.hosts = [...specHosts]

    let queryRunner: QueryRunner
    if (existingQueryRunner) {
      queryRunner = existingQueryRunner
    } else {
      queryRunner = AppDataSource.createQueryRunner()
      await queryRunner.connect()
      await queryRunner.startTransaction()
    }

    try {
      await queryRunner.manager.save(existingSpec)
      for (const item of Object.values(endpointsMap)) {
        await queryRunner.manager.save(item.endpoint)
        const similarEndpointUuids = []
        for (const e of Object.values(item.similarEndpoints)) {
          similarEndpointUuids.push(e.uuid)
          if (
            !item.endpoint.riskScore ||
            (item.endpoint.riskScore &&
              RISK_SCORE_ORDER[item.endpoint.riskScore] <
                RISK_SCORE_ORDER[e.riskScore])
          ) {
            item.endpoint.riskScore = e.riskScore
          }
          item.endpoint.updateDates(e.firstDetected)
          item.endpoint.updateDates(e.lastActive)
        }

        if (similarEndpointUuids.length > 0) {
          await queryRunner.manager.save(item.endpoint)
          const updateTracesQb = queryRunner.manager
            .createQueryBuilder()
            .update(ApiTrace)
            .set({ apiEndpointUuid: item.endpoint.uuid })
            .where(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
          const deleteDataFieldsQb = queryRunner.manager
            .createQueryBuilder()
            .delete()
            .from(DataField)
            .where(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
          const updateAlertsQb = queryRunner.manager
            .createQueryBuilder()
            .update(Alert)
            .set({ apiEndpointUuid: item.endpoint.uuid })
            .where(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
            .andWhere(`type NOT IN(:...types)`, {
              types: [AlertType.NEW_ENDPOINT, AlertType.OPEN_API_SPEC_DIFF],
            })
          const deleteAlertsQb = queryRunner.manager
            .createQueryBuilder()
            .delete()
            .from(Alert)
            .where(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })
            .andWhere(`type IN(:...types)`, {
              types: [AlertType.NEW_ENDPOINT, AlertType.OPEN_API_SPEC_DIFF],
            })
          const deleteAggregateHourlyQb = queryRunner.manager
            .createQueryBuilder()
            .delete()
            .from(AggregateTraceDataHourly)
            .where(`"apiEndpointUuid" IN(:...ids)`, {
              ids: similarEndpointUuids,
            })

          await updateTracesQb.execute()
          await queryRunner.query(insertDataFieldQuery, [
            similarEndpointUuids,
            item.endpoint.uuid,
          ])
          await deleteDataFieldsQb.execute()
          await updateAlertsQb.execute()
          await deleteAlertsQb.execute()
          await queryRunner.query(insertAggregateHourlyQuery, [
            item.endpoint.uuid,
            similarEndpointUuids,
          ])
          await deleteAggregateHourlyQb.execute()
          await queryRunner.manager
            .createQueryBuilder()
            .delete()
            .from(ApiEndpoint)
            .where(`"uuid" IN(:...ids)`, { ids: similarEndpointUuids })
            .execute()
        }
      }
      if (!existingQueryRunner) {
        await queryRunner.commitTransaction()
      }
    } catch (err) {
      if (!existingQueryRunner) {
        console.error(`Error updating database for spec upload: ${err}`)
        await queryRunner.rollbackTransaction()
      }
      throw new Error500InternalServer(err)
    } finally {
      if (!existingQueryRunner) {
        await queryRunner.release()
      }
    }
  }

  static async findOpenApiSpecDiff(
    trace: ApiTrace,
    endpoint: ApiEndpoint,
    queryRunner: QueryRunner,
  ): Promise<Alert[]> {
    try {
      const openApiSpecRepository = AppDataSource.getRepository(OpenApiSpec)
      const openApiSpec = await openApiSpecRepository.findOneBy({
        name: endpoint.openapiSpecName,
      })
      if (!openApiSpec || openApiSpec?.isAutoGenerated) {
        return []
      }
      const blockFieldEntry = await BlockFieldsService.getBlockFieldsEntry(
        trace,
      )
      const specObject: JSONValue = yaml.load(openApiSpec.spec) as JSONValue
      const parsedSpec = await SwaggerParser.dereference(specObject as any)
      const specPath =
        parsedSpec.paths?.[endpoint.path]?.[endpoint.method.toLowerCase()]

      // Validate request info
      const specRequestParameters = getSpecRequestParameters(
        parsedSpec,
        endpoint,
      )
      const specRequestBody: SpecValue = getSpecRequestBody(
        parsedSpec,
        endpoint,
      )
      const requestValidator = new OpenAPIRequestValidator({
        parameters: specRequestParameters?.value,
        requestBody: specRequestBody?.value,
        schemas: parsedSpec?.["components"]?.["schemas"] ?? {},
        errorTransformer: (error, ajvError) => {
          return ajvError
        },
        additionalQueryProperties: false,
        enableHeadersLowercase: true,
      })
      const headers = {}
      const body = parsedJsonNonNull(trace.requestBody)
      const query = {}
      const endpointPathTokens = getPathTokens(endpoint.path)
      const tracePathTokens = getPathTokens(trace.path)
      const pathParams = {}
      for (let i = 0; i < endpointPathTokens.length; i++) {
        const currToken = endpointPathTokens[i]
        if (isParameter(currToken)) {
          pathParams[currToken.slice(1, -1)] = parsePathParameter(
            tracePathTokens[i],
          )
        }
      }
      trace.requestHeaders.forEach(
        header => (headers[header.name] = header.value),
      )
      trace.requestParameters.forEach(
        parameter =>
          (query[parameter.name] = parsedJsonNonNull(parameter.value, true)),
      )
      const traceRequest = {
        headers,
        body,
        query,
        params: pathParams,
      }
      const requestErrors: AjvError[] =
        requestValidator.validateRequest(traceRequest)?.errors
      const reqErrorItems = generateAlertMessageFromReqErrors(
        requestErrors,
        specRequestParameters.path,
        specRequestBody.path,
        specRequestParameters.value,
        blockFieldEntry?.disabledPaths ?? [],
      )

      // Validate response info
      const responses = getSpecResponses(parsedSpec, endpoint)
      const responseValidator = new OpenAPIResponseValidator({
        components: specObject["components"],
        responses: responses?.value,
        errorTransformer: (error, ajvError) => {
          return ajvError
        },
      })
      const traceStatusCode = trace.responseStatus
      const resHeaders = trace.responseHeaders.reduce(
        (obj, item) => ((obj[item.name] = item.value), obj),
        {},
      )
      const traceResponseBody = parsedJsonNonNull(trace.responseBody, true)
      const responseValidationItems: OpenAPIResponseValidatorValidationError =
        responseValidator.validateResponse(
          traceStatusCode,
          traceResponseBody,
          resHeaders,
        )
      const responseErrors = responseValidationItems?.errors
      const respErrorItems = generateAlertMessageFromRespErrors(
        responseErrors as AjvError[],
        responses?.path,
        blockFieldEntry?.disabledPaths ?? [],
      )

      const errorItems = { ...reqErrorItems, ...respErrorItems }
      return await AlertService.createSpecDiffAlerts(
        errorItems,
        endpoint.uuid,
        trace,
        openApiSpec,
        queryRunner,
      )
    } catch (err) {
      console.error(`Error finding OpenAPI Spec diff: ${err}`)
      return []
    }
  }
}
