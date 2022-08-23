import { ConnectionType } from "@common/enums";
import { AWS_CONNECTION } from "@common/types";
import { AppDataSource } from "data-source";
import Error500InternalServer from "errors/error-500-internal-server";
import { Connections } from "models";

const save_connection = async ({
  conn_meta,
  name,
  id,
}: {
  conn_meta: AWS_CONNECTION;
  name: string;
  id: string;
}) => {
  const {
    access_id,
    secret_access_key,
    source_instance_id,
    region,
    ami,
    selected_instance_type,
    mirror_instance_id,
    mirror_session_id,
    mirror_target_id,
    mirror_filter_id,
    mirror_rules,
    keypair,
    destination_eni_id,
    backend_url,
    remote_machine_url,
  } = conn_meta;
  const conn = new Connections();

  conn.aws = {
    access_id,
    secret_access_key,
    source_instance_id,
    region,
    ami,
    selected_instance_type,
    mirror_instance_id,
    mirror_session_id,
    mirror_target_id,
    mirror_filter_id,
    mirror_rules,
    keypair,
    destination_eni_id,
    backend_url,
    remote_machine_url,
  } as AWS_CONNECTION;
  conn.connectionType = ConnectionType.AWS;
  conn.uuid = id;
  conn.name = name;
  try {
    const connectionRepository = AppDataSource.getRepository(Connections);
    await connectionRepository.save(conn);
  } catch (err) {
    console.error(`Error in saving connection: ${err}`);
    throw new Error500InternalServer(err);
  }
};

const list_connections = async () => {
  try {
    const connectionRepository = AppDataSource.getRepository(Connections);
    let resp = await connectionRepository
      .createQueryBuilder("conn")
      .select([
        "conn.uuid",
        "conn.name",
        "conn.createdAt",
        "conn.updatedAt",
        "conn.connectionType",
        "conn.aws",
      ])
      .getMany();
    return resp;
  } catch (err) {
    console.error(`Error in List Connections service: ${err}`);
    throw new Error500InternalServer(err);
  }
};

const get_connection_for_uuid = async (
  uuid: string,
  with_metadata: boolean = false
) => {
  try {
    const connectionRepository = AppDataSource.getRepository(Connections);
    const selects = [
      "conn.uuid",
      "conn.name",
      "conn.createdAt",
      "conn.updatedAt",
      "conn.connectionType",
      "conn.aws",
    ];
    if (with_metadata) {
      selects.push("conn.aws_meta");
    }
    let resp = connectionRepository
      .createQueryBuilder("conn")
      .select(selects)
      .where("conn.uuid = :uuid", { uuid })
      .getOne();
    return await resp;
  } catch (err) {
    console.error(`Error in List Connections service: ${err}`);
    throw new Error500InternalServer(err);
  }
};

const update_connection_for_uuid = async ({
  name,
  uuid,
}: {
  name: string;
  uuid: string;
}) => {
  try {
    let resp = AppDataSource.createQueryBuilder()
      .update(Connections)
      .set({ name: name })
      .where("uuid = :uuid", { uuid })
      .execute();
    return await resp;
  } catch (err) {
    console.error(`Error in List Connections service: ${err}`);
    throw new Error500InternalServer(err);
  }
};
export {
  save_connection,
  list_connections,
  get_connection_for_uuid,
  update_connection_for_uuid,
};