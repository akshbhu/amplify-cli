import {
  CfnTable,
  Table,
  GlobalSecondaryIndexProps,
  AttributeType,
  ProjectionType,
  LocalSecondaryIndexProps,
  SecondaryIndexProps,
} from '@aws-cdk/aws-dynamodb';
import { IAspect, IConstruct } from '@aws-cdk/core';

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
  indexProps: GlobalSecondaryIndexProps | LocalSecondaryIndexProps | SecondaryIndexProps;
}

export interface TableKeyType {
  keySchema?: KeySchema[];
  attributeDefintions?: AttributeDefinition[];
  isPrimary: boolean;
  index?: TableIndexProps;
}

export type GSIProps = GlobalSecondaryIndexProps;

export class DynamoDBTable implements IAspect {
  private keySchema: KeySchema[] | undefined;
  private attributeDefinition: AttributeDefinition[] | undefined;
  private tableIndexProps: TableKeyType | undefined;
  constructor(tableIndexArgs: TableKeyType, keySchemaArgs: KeySchema[], attributeDefinitionsArgs: AttributeDefinition[]) {
    this.keySchema = keySchemaArgs;
    this.attributeDefinition = attributeDefinitionsArgs;
    this.tableIndexProps = tableIndexArgs;
  }

  replacePrimaryKey = (node: CfnTable) => {
    if (this.isPrimaryKey()) {
      let x1 = 0;
      for (const x of this.keySchema!) {
        node.addPropertyOverride(`KeySchema.${x1}.AttributeName`, `${x.attributeName}`);
        node.addPropertyOverride(`KeySchema.${x1}.KeyType`, `${x.keyType}`);
        x1++;
      }
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
    if (this.tableIndexProps?.index?.indexType === IndexType.LSI) {
      const lsiProps: LocalSecondaryIndexProps = {
        ...this.tableIndexProps.index.indexProps,
        sortKey: { name: this.attributeDefinition![1].attributeName, type: this.attributeDefinition![1].attributeType as AttributeType },
        projectionType: ProjectionType.ALL,
      };
      node.addLocalSecondaryIndex(lsiProps);
    } else {
      // This is a GSI.
      // Add the new secondary index and update the table's attribute definitions.
      const gsiProps: GlobalSecondaryIndexProps = {
        ...this.tableIndexProps!.index!.indexProps,
        partitionKey: {
          name: this.attributeDefinition![1].attributeName,
          type: this.attributeDefinition![1].attributeType as AttributeType,
        },
        projectionType: ProjectionType.ALL,
      };
      node.addGlobalSecondaryIndex(gsiProps);
    }
    // Adding attributes for GSI and LSI

    // const props: GSIProps = { partitionKey: { name: 'akshay', type: AttributeType.STRING }, indexName: 'akshay1' };
    // node.addGlobalSecondaryIndex(props);
    // console.log(node);
  };

  public visit(node: IConstruct): void {
    if (node instanceof CfnTable) {
      this.replacePrimaryKey(node);
    }
    if (node instanceof Table) {
      if (!this.isPrimaryKey()) {
        this.appendSecondaryIndex(node);
      }
    }
  }
}
