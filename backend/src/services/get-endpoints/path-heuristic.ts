import { Brackets, QueryRunner, Raw } from "typeorm"
import { v4 as uuidv4 } from "uuid"
import { RestMethod, RiskScore } from "@common/enums"
import { getPathTokens } from "@common/utils"
import { AppDataSource } from "data-source"
import Error400BadRequest from "errors/error-400-bad-request"
import { ApiEndpoint, ApiTrace } from "models"
import { getEntityManager, getQB, getRepository } from "services/database/utils"
import { MetloContext } from "types"
import { endpointAddNumberParams, getPathRegex, getValidPath } from "utils"
import Error404NotFound from "errors/error-404-not-found"
import { GetEndpointsService } from "."
import Error500InternalServer from "errors/error-500-internal-server"

const TRACE_LIMIT = 10_000
const THRESHOLD = 0.1

interface EndpointsMap {
  endpoint: ApiEndpoint
  similarEndpoints: Record<string, ApiEndpoint>
}

const getCounterMap = (traces: ApiTrace[]) => {
  const counterMap = {}
  for (const trace of traces) {
    const pathTokens = getPathTokens(trace.path)
    for (let i = 0; i < pathTokens.length; i++) {
      const token = pathTokens[i]
      const pos = i.toString()
      if (!counterMap[pos]) {
        counterMap[pos] = {}
      }
      if (!counterMap[pos][token]) {
        counterMap[pos][token] = 1
      } else {
        counterMap[pos][token] += 1
      }
    }
  }
  return counterMap
}

const getDistinctPaths = (
  counterMap: any,
  traces: ApiTrace[],
  numTraces: number,
): Record<string, number> => {
  const distinctPaths: Record<string, number> = {}
  for (const trace of traces) {
    const pathTokens = getPathTokens(trace.path)
    let path = ""
    let totalPercent = 0
    const numTokens = pathTokens.length
    let paramNum = 1
    for (let i = 0; i < numTokens; i++) {
      const token = pathTokens[i]
      const pos = i.toString()
      const tokenPercentOccurence = counterMap[pos][token] / numTraces
      totalPercent += tokenPercentOccurence
      if (tokenPercentOccurence < THRESHOLD) {
        path += `/{param${paramNum++}}`
      } else {
        path += `/${token}`
      }
    }
    const avgTotalPctOccurence = totalPercent / numTokens
    if (!distinctPaths[path] || avgTotalPctOccurence > distinctPaths?.[path]) {
      distinctPaths[path] = avgTotalPctOccurence
    }
  }
  return distinctPaths
}

export const getTopSuggestedPaths = async (
  ctx: MetloContext,
  endpointId: string,
): Promise<string[]> => {
  const traces = await getRepository(ctx, ApiTrace).find({
    select: {
      path: true,
    },
    where: {
      apiEndpointUuid: endpointId,
    },
    take: TRACE_LIMIT,
    order: {
      createdAt: "DESC",
    },
  })
  const numTraces = traces.length
  const counterMap = getCounterMap(traces)
  const distinctPaths = getDistinctPaths(counterMap, traces, numTraces)
  const sorted = Object.keys(distinctPaths).sort(
    (a, b) => distinctPaths[b] - distinctPaths[a],
  )
  return sorted.slice(0, 100)
}

export const updatePaths = async (
  ctx: MetloContext,
  providedPaths: string[],
  endpointId: string,
) => {
  if (!providedPaths || !Array.isArray(providedPaths)) {
    throw new Error400BadRequest("Must provide list of paths to create.")
  }
  const queryRunner = AppDataSource.createQueryRunner()
  try {
    await queryRunner.connect()
    const endpoint: ApiEndpoint = await getQB(ctx, queryRunner)
      .from(ApiEndpoint, "endpoint")
      .andWhere("uuid = :id", { id: endpointId })
      .getRawOne()
    if (!endpoint) {
      throw new Error404NotFound("Endpoint not found.")
    }
    const endpointsMap = await generateEndpointsMap(
      ctx,
      providedPaths,
      endpoint.method,
      endpoint.host,
      queryRunner,
      getPathTokens(endpoint.path).length,
    )
    await queryRunner.startTransaction()
    await updateEndpointsFromMap(ctx, endpointsMap, queryRunner)
    await queryRunner.commitTransaction()
  } catch (err) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction()
    }
    throw err
  } finally {
    await queryRunner.release()
  }
}

export const updateEndpointsFromMap = async (
  ctx: MetloContext,
  endpointsMap: Record<string, EndpointsMap>,
  queryRunner: QueryRunner,
) => {
  for (const item of Object.values(endpointsMap)) {
    item.endpoint.riskScore = RiskScore.NONE
    await getEntityManager(ctx, queryRunner).save(item.endpoint)
    const similarEndpointUuids = Object.values(item.similarEndpoints).map(
      e => e.uuid,
    )
    if (similarEndpointUuids.length > 0) {
      await GetEndpointsService.deleteEndpointsBatch(
        ctx,
        similarEndpointUuids,
        queryRunner,
      )
    }
  }
}

export const generateEndpointsMap = async (
  ctx: MetloContext,
  providedPaths: string[],
  method: RestMethod,
  host: string,
  queryRunner: QueryRunner,
  numTokens: number,
) => {
  const endpointsMap: Record<string, EndpointsMap> = {}
  const set = new Set<string>()
  for (const item of providedPaths) {
    const validPath = getValidPath(item, numTokens)
    if (!validPath.isValid) {
      throw new Error400BadRequest(
        `${item ? `${item}:` : ""} ${validPath.errMsg}`,
      )
    }
    let apiEndpoint = await getEntityManager(ctx, queryRunner).findOne(
      ApiEndpoint,
      {
        where: {
          path: validPath.path,
          method,
          host,
        },
      },
    )
    if (apiEndpoint) {
      throw new Error400BadRequest(
        `${item}: An endpoint with this path already exists for this method and host.`,
      )
    }
    set.add(validPath.path)
  }

  for (const path of [...set]) {
    const pathRegex = getPathRegex(path)
    const apiEndpoint = new ApiEndpoint()
    apiEndpoint.uuid = uuidv4()
    apiEndpoint.path = path
    apiEndpoint.pathRegex = pathRegex
    apiEndpoint.method = method
    apiEndpoint.host = host
    endpointAddNumberParams(apiEndpoint)
    endpointsMap[apiEndpoint.uuid] = {
      endpoint: apiEndpoint,
      similarEndpoints: {},
    }

    const similarEndpoints = await getQB(ctx, queryRunner)
      .from(ApiEndpoint, "endpoint")
      .andWhere(
        new Brackets(qb => {
          qb.where(`:path ~ "pathRegex"`, { path }).orWhere(
            `path ~ :pathRegex`,
            { pathRegex },
          )
        }),
      )
      .andWhere("method = :method", { method })
      .andWhere("host = :host", { host })
      .getRawMany()
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
        endpointsMap[apiEndpoint.uuid].similarEndpoints[item.uuid] = item
      }
    })
  }
  return endpointsMap
}
