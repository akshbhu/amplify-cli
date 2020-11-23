import { CfnTable, Table, GlobalSecondaryIndexProps, AttributeType, ProjectionType, SecondaryIndexProps } from '@aws-cdk/aws-dynamodb';
import { IAspect, IConstruct } from '@aws-cdk/core';
import { KeyDirectiveConfiguration } from '../graphql-key-transformer';

export interface KeySchema {
  attributeName: string;
  keyType: string;
}

export interface AttributeDefinition {
  attributeName: string;
  attributeType: string;
}

export enum IndexType {
  GSI = 'GSI',
  LSI = 'LSI',
}

export interface TableIndexProps {
  indexType: IndexType;
  indexProps: SecondaryIndexProps;
}

export interface TableKeyType {
  isPrimary: boolean;
  index?: TableIndexProps;
}

export type GSIProps = GlobalSecondaryIndexProps;

export class DynamoDBTable implements IAspect {
  private keySchema: KeySchema[] | undefined;
  private attributeDefinition: AttributeDefinition[] | undefined;
  private tableIndexProps: TableKeyType | undefined;
  constructor(keySchemaArgs: KeySchema[], attributeDefinitionsArgs: AttributeDefinition[], tableIndexArgs: TableKeyType) {
    this.keySchema = keySchemaArgs;
    this.attributeDefinition = attributeDefinitionsArgs;
    this.tableIndexProps = Object.assign(this.tableIndexProps, tableIndexArgs);
  }

  replacePrimaryKey = (node: CfnTable) => {
    let x1 = 0;
    for (const x of this.keySchema!) {
      node.addPropertyOverride(`KeySchema.${x1}.AttributeName`, `${x.attributeName}`);
      node.addPropertyOverride(`KeySchema.${x1}.KeyType`, `${x.keyType}`);
      x1++;
    }
    let x2 = 0;
    for (const x of this.attributeDefinition!) {
      node.addPropertyOverride(`AttributeDefinitions.${x2}.AttributeName`, `${x.attributeName}`);
      node.addPropertyOverride(`AttributeDefinitions.${x2}.AttributeType`, `${x.attributeType}`);
      x2++;
    }
  };

  isPrimaryKey = (): boolean => {
    return Boolean(this.tableIndexProps?.isPrimary);
  };

  appendSecondaryIndex = (node: Table) => {
    // const IndexProperties : SecondaryIndexProps = Object.assign(this.tableIndexProps?.index?.indexProps ,{projectionType: ProjectionType.ALL });
    //   if (this.tableIndexProps?.index?.indexType === IndexType.LSI) {
    //       const lsiIndexProps : LocalSec
    //     // This is an LSI.
    //     // Add the new secondary index and update the table's attribute definitions.
    //     node.addLocalSecondaryIndex();
    //   } else {
    //     // This is a GSI.
    //     // Add the new secondary index and update the table's attribute definitions.
    //     tableResource.Properties.GlobalSecondaryIndexes = append(
    //       tableResource.Properties.GlobalSecondaryIndexes,
    //       new GlobalSecondaryIndex({
    //         ...baseIndexProperties,
    //         ProvisionedThroughput: Fn.If(ResourceConstants.CONDITIONS.ShouldUsePayPerRequestBilling, Refs.NoValue, {
    //           ReadCapacityUnits: Fn.Ref(ResourceConstants.PARAMETERS.DynamoDBModelTableReadIOPS),
    //           WriteCapacityUnits: Fn.Ref(ResourceConstants.PARAMETERS.DynamoDBModelTableWriteIOPS),
    //         }) as any,
    //       }),
    //     );
    //   }
    //   const existingAttrDefSet = new Set(tableResource.Properties.AttributeDefinitions.map(ad => ad.AttributeName));
    //   for (const attr of attrDefs) {
    //     if (!existingAttrDefSet.has(attr.AttributeName)) {
    //       tableResource.Properties.AttributeDefinitions.push(attr);
    //     }
    //   }

    const props: GSIProps = { partitionKey: { name: 'akshay', type: AttributeType.STRING }, indexName: 'akshay1' };
    node.addGlobalSecondaryIndex(props);
    console.log(node);
  };

  public visit(node: IConstruct): void {
    if (node instanceof CfnTable) {
      if (this.isPrimaryKey()) {
        this.replacePrimaryKey(node);
      }
    }
    if (node instanceof Table) {
      if (!this.isPrimaryKey()) {
        this.appendSecondaryIndex(node);
      }
    }
  }
}
